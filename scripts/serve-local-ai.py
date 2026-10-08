#!/usr/bin/env python3
"""Serve EnglishTool and proxy Ollama/LM Studio model and chat APIs on loopback."""
import argparse
import json
import os
import select
import socket
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, unquote, parse_qs
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

ROOT = Path(__file__).resolve().parents[1]
MAX_BODY = 100000
MAX_REPLY = 1000000
CHAT_DEADLINE = 300   # seconds for a whole answer
READ_TIMEOUT = 120    # seconds without any new output from the model


class ClientDisconnected(Exception):
    """The browser closed the request, e.g. the learner closed the analysis dialog."""


def ollama_model_ids(body):
    if not isinstance(body, dict) or not isinstance(body.get('models'), list):
        raise ValueError('Invalid models response')
    return [model['name'] for model in body['models']
            if isinstance(model, dict) and isinstance(model.get('name'), str)
            and not model.get('remote_host') and not model.get('remote_model')
            and not model['name'].endswith(('-cloud', ':cloud'))
            and (not model.get('capabilities') or 'completion' in model['capabilities'])]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LocalAIHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status, body):
        data = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def error_json(self, status, code):
        self.send_json(status, {'error': {'code': code}})

    def trusted_request(self):
        port = self.server.server_port
        allowed = {f'127.0.0.1:{port}', f'localhost:{port}'}
        host = self.headers.get('Host', '')
        origin = self.headers.get('Origin')
        return (host in allowed and (not origin or origin == f'http://{host}')
                and self.headers.get('Sec-Fetch-Site') != 'cross-site')

    def safe_static_path(self):
        relative = unquote(urlsplit(self.path).path).lstrip('/')
        path = (ROOT / relative).resolve()
        return (not any(part.startswith('.') for part in Path(relative).parts)
                and path.is_relative_to(ROOT))

    def do_GET(self):
        if not self.trusted_request():
            return self.error_json(403, 'origin')
        if urlsplit(self.path).path == '/local-ai/models':
            provider = parse_qs(urlsplit(self.path).query).get('provider', ['lmstudio'])[0]
            if provider not in ('ollama', 'lmstudio'):
                return self.error_json(400, 'invalid')
            return self.proxy('models', provider=provider)
        if not self.safe_static_path():
            return self.send_error(404)
        super().do_GET()

    def do_HEAD(self):
        if not self.trusted_request() or not self.safe_static_path():
            return self.send_error(403)
        super().do_HEAD()

    def do_POST(self):
        if not self.trusted_request():
            return self.error_json(403, 'origin')
        if urlsplit(self.path).path != '/local-ai/chat':
            return self.error_json(404, 'missing')
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
            return self.error_json(415, 'invalid')
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY:
                return self.error_json(413, 'invalid')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict) or not isinstance(body.get('model'), str) or not body['model'].strip():
                raise ValueError('Missing model')
            provider = body.get('provider', 'lmstudio')
            if provider not in ('ollama', 'lmstudio'):
                raise ValueError('Invalid provider')
            messages = body.get('messages')
            if (not isinstance(messages, list) or len(messages) != 1 or not isinstance(messages[0], dict)
                    or messages[0].get('role') != 'user' or not isinstance(messages[0].get('content'), str)
                    or not 0 < len(messages[0]['content']) <= 32000):
                raise ValueError('Invalid prompt')
            # Whitelist completion fields; never forward arbitrary URLs or tools.
            payload = {'model': body['model'], 'messages': messages, 'stream': False,
                       'temperature': 0.2, 'max_tokens': 8192}
            if isinstance(body.get('response_format'), dict):
                json_schema = body['response_format'].get('json_schema')
                if not isinstance(json_schema, dict) or not isinstance(json_schema.get('schema'), dict):
                    raise ValueError('Invalid response schema')
                payload['response_format'] = body['response_format']
        except (ValueError, TypeError, UnicodeDecodeError):
            return self.error_json(400, 'invalid')
        self.proxy('chat/completions', payload, provider)

    def client_gone(self):
        """True once the browser has closed its connection."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b''
        except (OSError, ValueError):
            return True

    def read_ollama_stream(self, reply, deadline):
        """Collect a streamed Ollama answer. Stops early when the browser goes away, so
        leaving the `with` block closes the upstream connection and Ollama stops generating."""
        parts, size = [], 0
        for line in reply:
            if self.client_gone():
                raise ClientDisconnected()
            if time.monotonic() > deadline:
                raise TimeoutError()
            size += len(line)
            if size > MAX_REPLY:
                raise ValueError('Model response too large')
            if not line.strip():
                continue
            chunk = json.loads(line)
            if not isinstance(chunk, dict) or chunk.get('error'):
                raise ValueError('Model error')
            content = (chunk.get('message') or {}).get('content')
            if isinstance(content, str):
                parts.append(content)
            if chunk.get('done') is True:
                return {'choices': [{'message': {'role': 'assistant', 'content': ''.join(parts)},
                                     'finish_reason': 'length' if chunk.get('done_reason') == 'length' else 'stop'}]}
        raise ValueError('Incomplete model response')

    def proxy(self, route, payload=None, provider='lmstudio'):
        headers = {'Content-Type': 'application/json'}
        token = self.server.lm_token if provider == 'lmstudio' else ''
        if token:
            headers['Authorization'] = f'Bearer {token}'
        try:
            if provider == 'ollama':
                endpoint = 'tags' if payload is None else 'chat'
                url = f'http://127.0.0.1:{self.server.ollama_port}/api/{endpoint}'
                if payload is not None:
                    # Re-check the model before inference to keep this integration local.
                    with self.server.upstream.open(Request(f'http://127.0.0.1:{self.server.ollama_port}/api/tags'), timeout=8) as reply:
                        raw_models = reply.read(MAX_REPLY + 1)
                        if len(raw_models) > MAX_REPLY:
                            raise ValueError('Model list too large')
                        if payload['model'] not in ollama_model_ids(json.loads(raw_models)):
                            return self.error_json(400, 'model')
                    schema = payload.get('response_format', {}).get('json_schema', {}).get('schema')
                    payload = {'model': payload['model'], 'messages': payload['messages'],
                               'stream': True, 'think': False,
                               'options': {'temperature': 0.2, 'num_ctx': 16384, 'num_predict': 8192},
                               'format': schema if isinstance(schema, dict) else 'json'}
            else:
                url = f'http://127.0.0.1:{self.server.lm_port}/v1/{route}'
            request = Request(url, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
            if provider == 'ollama' and payload is not None:
                with self.server.upstream.open(request, timeout=READ_TIMEOUT) as reply:
                    body = self.read_ollama_stream(reply, time.monotonic() + CHAT_DEADLINE)
                return self.send_json(200, body)
            with self.server.upstream.open(request, timeout=CHAT_DEADLINE if payload else 8) as reply:
                raw = reply.read(MAX_REPLY + 1)
                if len(raw) > MAX_REPLY:
                    return self.error_json(502, 'invalid')
                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise ValueError('Invalid response')
                if provider == 'ollama':
                    body = {'data': [{'id': name} for name in ollama_model_ids(body)]}
                self.send_json(200, body)
        except ClientDisconnected:
            pass  # nobody is waiting for an answer
        except HTTPError as error:
            self.error_json(502, 'authentication' if error.code in (401, 403) else 'upstream')
        except (TimeoutError, socket.timeout, URLError) as error:
            # Python 3.9's socket.timeout is not yet a TimeoutError
            reason = getattr(error, 'reason', error)
            timed_out = isinstance(reason, (TimeoutError, socket.timeout))
            self.error_json(504 if timed_out else 503, 'timeout' if timed_out else 'unavailable')
        except (ValueError, OSError):
            self.error_json(502, 'invalid')

    def list_directory(self, path):
        self.send_error(404)
        return None


def make_server(port, lm_port=1234, token='', ollama_port=11434):
    server = ThreadingHTTPServer(('127.0.0.1', port), LocalAIHandler)
    server.lm_port = lm_port
    server.lm_token = token
    server.ollama_port = ollama_port
    server.upstream = build_opener(ProxyHandler({}), NoRedirect())
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--lmstudio-port', type=int, default=1234)
    parser.add_argument('--ollama-port', type=int, default=11434)
    args = parser.parse_args()
    if not all(1 <= port <= 65535 for port in (args.port, args.lmstudio_port, args.ollama_port)):
        parser.error('Ports must be between 1 and 65535')
    with make_server(args.port, args.lmstudio_port, os.environ.get('LM_STUDIO_API_TOKEN', ''), args.ollama_port) as server:
        print(f'EnglishTool: http://127.0.0.1:{args.port} — Ollama: {args.ollama_port}; LM Studio: {args.lmstudio_port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
