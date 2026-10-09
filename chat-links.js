/* "… with Claude" / "… with ChatGPT" buttons: real links (<a data-chat>) plus a copied prompt.
   iOS only hands a link to an installed app when you tap a real link that opens in the same tab, and only
   for addresses the app claims: the ChatGPT app claims https://chatgpt.com/#native (a new chat), not the
   plain home page. So on iPhone/iPad the ChatGPT button opens the app; elsewhere both open a new tab. */
'use strict';

// Chat sites a prompt can be pasted into; the reply can be brought back the same way from either
const AI_CHATS = {
  claude: { name: 'Claude', url: 'https://claude.ai/new' },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/', appUrl: 'https://chatgpt.com/#native' },
};

// iPhone, iPod, or iPad — which reports itself as a Mac in desktop mode, but has a touch screen
const isAppleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function setupChatLinks() {
  const appleMobile = isAppleMobile();
  document.querySelectorAll('a[data-chat]').forEach(link => {
    const chat = AI_CHATS[link.dataset.chat];
    link.href = (appleMobile && chat.appUrl) || chat.url;
    if (appleMobile) {
      link.removeAttribute('target');
    } else {
      link.target = '_blank';
      link.rel = 'noopener';
    }
  });
}

// Copies the prompt when its link is tapped; the link itself opens the chat. Starts inside the tap,
// because browsers only allow copying during one.
function copyChatPrompt(service, text, successMsg = `Prompt copied → paste it into ${AI_CHATS[service].name}. / 提示词已复制，请粘贴到 ${AI_CHATS[service].name}。`) {
  const copying = navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));
  return copying
    .then(() => toast(successMsg, 3000))
    .catch(error => {
      console.warn('Clipboard write failed', error);
      toast('Copy failed — your browser blocked clipboard access');
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupChatLinks);
else setupChatLinks();
