import importlib.util
import io
import json
import threading
import time
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('local_server', Path(__file__).resolve().parents[1] / 'scripts/serve-local-ai.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class Upstream:
    def __init__(self):
        self.request = None
        self.failure = None
        self.requests = []

    def open(self, request, timeout):
        self.request = request
        self.requests.append(request)
        if self.failure:
            raise self.failure
        if request.full_url.endswith('/api/tags'):
            payload = {'models': [{'name': 'qwen3.5:4b', 'capabilities': ['completion']},
                                  {'name': 'embed', 'capabilities': ['embedding']},
                                  {'name': 'remote:cloud', 'capabilities': ['completion']},
                                  {'name': 'remote-alias', 'remote_host':'https://example.com'}]}
        elif request.full_url.endswith('/api/chat'):
            # Ollama streams one JSON object per line
            chunks = [{'message': {'role':'assistant','content':'{"test":'}, 'done':False},
                      {'message': {'role':'assistant','content':'true}'}, 'done':False},
                      {'message': {'role':'assistant','content':''}, 'done':True, 'done_reason':'stop'}]
            return Reply(b''.join(json.dumps(chunk).encode() + b'\n' for chunk in chunks))
        else:
            payload = {'data': [{'id': 'test-model'}]} if request.data is None else {'choices': [{'message': {'content': '{}'}}]}
        return Reply(json.dumps(payload).encode())


class LocalServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = module.make_server(0, token='test-token')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.upstream = Upstream()
        self.server.upstream = self.upstream

    def request(self, path, body=None, headers=None):
        merged = {'Content-Type': 'application/json'}
        merged.update(headers or {})
        request = Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, headers=merged)
        try:
            with urlopen(request, timeout=3) as reply:
                return reply.status, reply.read()
        except HTTPError as error:
            return error.code, error.read()

    def test_static_app_and_models(self):
        status, body = self.request('/')
        self.assertEqual(status, 200)
        self.assertIn(b'Book Reader', body)
        status, body = self.request('/local-ai/models')
        self.assertEqual(json.loads(body)['data'][0]['id'], 'test-model')
        self.assertEqual(self.upstream.request.full_url, 'http://127.0.0.1:1234/v1/models')
        self.assertEqual(self.upstream.request.get_header('Authorization'), 'Bearer test-token')

    def test_chat_payload_is_whitelisted(self):
        status, _ = self.request('/local-ai/chat', {'model':'test-model', 'messages':[{'role':'user','content':'test'}], 'tools':[{}], 'url':'https://example.com'})
        self.assertEqual(status, 200)
        self.assertEqual(self.upstream.request.full_url, 'http://127.0.0.1:1234/v1/chat/completions')
        payload = json.loads(self.upstream.request.data)
        self.assertNotIn('url', payload)
        self.assertNotIn('tools', payload)
        self.assertFalse(payload['stream'])

    def test_ollama_discovery_only_lists_local_chat_models(self):
        status, body = self.request('/local-ai/models?provider=ollama')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['data'], [{'id':'qwen3.5:4b'}])
        self.assertEqual(self.upstream.request.full_url, 'http://127.0.0.1:11434/api/tags')
        self.assertIsNone(self.upstream.request.get_header('Authorization'))

    def test_ollama_chat_uses_native_structured_output_and_normalizes_response(self):
        schema = {'type':'object','properties':{'test':{'type':'boolean'}}}
        status, body = self.request('/local-ai/chat', {'provider':'ollama','model':'qwen3.5:4b',
            'messages':[{'role':'user','content':'test'}],
            'response_format':{'type':'json_schema','json_schema':{'schema':schema}}})
        self.assertEqual(status, 200)
        self.assertEqual(self.upstream.request.full_url, 'http://127.0.0.1:11434/api/chat')
        payload = json.loads(self.upstream.request.data)
        self.assertEqual(payload['format'], schema)
        self.assertFalse(payload['think'])
        self.assertTrue(payload['stream'], 'Streaming lets the server stop the model when the browser gives up')
        self.assertEqual(payload['options']['num_ctx'], 16384)
        self.assertTrue(all(request.get_header('Authorization') is None for request in self.upstream.requests))
        self.assertEqual(json.loads(body)['choices'][0]['message']['content'], '{"test":true}')

    def test_ollama_does_not_run_uninstalled_or_remote_models(self):
        status, body = self.request('/local-ai/chat', {'provider':'ollama','model':'remote-alias', 'messages':[{'role':'user','content':'test'}]})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)['error']['code'], 'model')
        self.assertEqual(len(self.upstream.requests), 1, 'Only the local model-list request should run')

    def test_unknown_providers_and_invalid_schemas_are_rejected(self):
        self.assertEqual(self.request('/local-ai/models?provider=remote')[0], 400)
        self.assertEqual(self.request('/local-ai/chat', {'provider':'remote','model':'x','messages':[{'role':'user','content':'x'}]})[0], 400)
        self.assertEqual(self.request('/local-ai/chat', {'provider':'ollama','model':'x','messages':[{'role':'user','content':'x'}], 'response_format':{'json_schema':'bad'}})[0], 400)
        self.assertIsNone(self.upstream.request)

    def test_cross_origin_and_rebinding_requests_are_rejected(self):
        self.assertEqual(self.request('/local-ai/models', headers={'Origin':'https://example.com'})[0], 403)
        self.assertEqual(self.request('/', headers={'Host':'example.com'})[0], 403)
        self.assertEqual(self.request('/local-ai/models', headers={'Sec-Fetch-Site':'cross-site'})[0], 403)
        self.assertIsNone(self.upstream.request)

    def test_invalid_payload_and_private_files_are_rejected(self):
        self.assertEqual(self.request('/local-ai/chat', [])[0], 400)
        self.assertEqual(self.request('/local-ai/chat', {'model':'x','messages':[{'role':'system','content':'x'}]})[0], 400)
        self.assertEqual(self.request('/.git/config')[0], 404)
        self.assertEqual(self.request('/%2e%2e/other')[0], 404)
        self.assertIsNone(self.upstream.request)

    def test_upstream_failures_are_actionable_without_leaking_body_or_token(self):
        self.upstream.failure = HTTPError('http://localhost',401,'secret body',None,None)
        status, body = self.request('/local-ai/models')
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body)['error']['code'], 'authentication')
        self.assertNotIn(b'test-token', body)
        self.upstream.failure = TimeoutError()
        self.assertEqual(json.loads(self.request('/local-ai/models')[1])['error']['code'], 'timeout')

    def test_ollama_stream_stops_reading_when_the_browser_disconnects(self):
        chunk = json.dumps({'message': {'content': 'x'}, 'done': False}).encode() + b'\n'
        reply = Reply(chunk * 50)

        class GoneBrowser:
            def client_gone(self):
                return True
        with self.assertRaises(module.ClientDisconnected):
            module.LocalAIHandler.read_ollama_stream(GoneBrowser(), reply, time.monotonic() + 60)
        self.assertLessEqual(reply.tell(), len(chunk), 'Stop reading so the upstream connection can be closed')

    def test_ollama_stream_has_an_overall_time_limit_and_reports_truncation(self):
        class Browser:
            def client_gone(self):
                return False
        chunk = json.dumps({'message': {'content': 'x'}, 'done': False}).encode() + b'\n'
        with self.assertRaises(TimeoutError):
            module.LocalAIHandler.read_ollama_stream(Browser(), Reply(chunk * 3), time.monotonic() - 1)
        done = json.dumps({'message': {'content': 'y'}, 'done': True, 'done_reason': 'length'}).encode()
        body = module.LocalAIHandler.read_ollama_stream(Browser(), Reply(chunk + done), time.monotonic() + 60)
        self.assertEqual(body['choices'][0]['message']['content'], 'xy')
        self.assertEqual(body['choices'][0]['finish_reason'], 'length')


if __name__ == '__main__':
    unittest.main()
