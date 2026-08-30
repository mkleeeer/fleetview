// 페이지 안에서 실행되는 조작 코드. 확장과 서버(CDP)가 같은 파일을 공유한다.
// 주의: 이 함수는 문자열로 직렬화되어 페이지 컨텍스트로 들어간다. 바깥 스코프를 참조하면 안 된다.
export function pageAgent(action, text) {
  const HOST = location.hostname;
  const SITE = HOST.includes('claude.ai') ? 'claude'
    : (HOST.includes('chatgpt.com') || HOST.includes('openai.com')) ? 'chatgpt'
    : HOST.includes('gemini.google.com') ? 'gemini' : 'unknown';

  const SEL = {
    claude: {
      input: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'],
      send: ['button[aria-label="Send message"]', 'button[aria-label*="Send"]', 'button[aria-label*="보내기"]', 'button[type="submit"]'],
      msg: ['div[data-is-streaming]', '.font-claude-message', 'div[data-testid="conversation-turn"]'],
      streaming: () => !!document.querySelector('[data-is-streaming="true"]'),
    },
    chatgpt: {
      input: ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea[data-id]'],
      send: ['button[data-testid="send-button"]', 'button[aria-label*="Send"]', 'button[aria-label*="보내기"]'],
      msg: ['[data-message-author-role="assistant"]'],
      streaming: () => !!document.querySelector('button[data-testid="stop-button"]'),
    },
    gemini: {
      input: ['div.ql-editor[contenteditable="true"]', 'rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]'],
      send: ['button.send-button', 'button[aria-label*="Send"]', 'button[aria-label*="보내기"]', 'button[aria-label*="제출"]'],
      msg: ['model-response message-content', 'message-content.model-response-text', '.model-response-text'],
      streaming: () => !!document.querySelector('.stop-icon, button[aria-label*="Stop"], button[aria-label*="중지"]'),
    },
    unknown: { input: ['textarea', 'div[contenteditable="true"]'], send: ['button[type="submit"]'], msg: [], streaming: () => false },
  }[SITE];

  const pick = (list) => {
    for (const s of list) {
      const els = [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null || e.getClientRects().length);
      if (els.length) return els[els.length - 1];
    }
    return null;
  };
  const msgs = () => {
    for (const s of SEL.msg) {
      const els = [...document.querySelectorAll(s)];
      if (els.length) return els;
    }
    return [];
  };
  const lastMsgText = () => {
    const m = msgs();
    return m.length ? (m[m.length - 1].innerText || '').trim() : '';
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function typeIn(el, value) {
    el.focus();
    el.click();
    await sleep(30);
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // contenteditable(ProseMirror / Quill): execCommand 가 프레임워크 이벤트를 정상 발생시킨다
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function clickSend() {
    for (let i = 0; i < 20; i++) {
      const btn = pick(SEL.send);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') { btn.click(); return true; }
      await sleep(150);
    }
    // 버튼을 못 찾으면 엔터로 시도
    const el = pick(SEL.input);
    if (el) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return true;
    }
    return false;
  }

  async function waitForReply(beforeCount, beforeText) {
    const deadline = Date.now() + 170000;
    let stable = 0;
    let prev = '';
    let grew = false;
    while (Date.now() < deadline) {
      await sleep(700);
      const list = msgs();
      const cur = lastMsgText();
      if (list.length > beforeCount || (cur && cur !== beforeText)) grew = true;
      if (!grew) continue;
      if (SEL.streaming()) { stable = 0; prev = cur; continue; }
      if (cur && cur === prev) {
        stable++;
        if (stable >= 3) return cur; // 2초 이상 변화 없고 스트리밍 표시도 없음
      } else {
        stable = 0;
      }
      prev = cur;
    }
    return prev || '(응답을 읽지 못했습니다)';
  }

  return (async () => {
    if (action === 'read') {
      return { site: SITE, reply: lastMsgText(), count: msgs().length, streaming: SEL.streaming() };
    }
    const input = pick(SEL.input);
    if (!input) throw new Error(SITE + ' 입력창을 찾지 못했습니다');
    const before = msgs().length;
    const beforeText = lastMsgText();
    await typeIn(input, text);
    await sleep(120);
    const sent = await clickSend();
    if (!sent) throw new Error('전송 버튼을 찾지 못했습니다');
    if (action === 'send') return { site: SITE, sent: true };
    const reply = await waitForReply(before, beforeText);
    return { site: SITE, reply };
  })();
}
