'use strict';
/**
 * 브라우저/데스크톱 앱 UI 자동화 어댑터.
 *
 * 공식 API 가 없는 소비자 앱을 구독 그대로 쓰기 위한 경로다.
 * 성격상 상대 사이트의 DOM 에 의존하므로 안정성이 API 어댑터보다 낮다.
 * 그래서 kind 를 'ui' 로 표시하고, UI 에서 그 사실을 드러낸다.
 *
 * 크롬 탭은 확장을 통해, ChatGPT 데스크톱 앱은 CDP 를 통해 같은 조작 코드를 돌린다.
 */
const { AdapterError, register } = require('./contract');
const bridge = require('../bridge');
const appBridge = require('../appBridge');
const store = require('../store');

function normalize(e, adapterId, provider) {
  const msg = (e && e.message) || String(e);
  let code = 'internal';
  if (/확장이 연결|연결되어 있지 않|디버그 모드로 떠 있지 않/.test(msg)) code = 'unavailable';
  else if (/시간 초과/.test(msg)) code = 'timeout';
  else if (/찾지 못했습니다/.test(msg)) code = 'not_found';
  return new AdapterError(code, msg, { provider, adapterId, cause: e });
}


/**
 * 응답 완료를 서버 쪽에서 기다린다.
 *
 * 확장(MV3 서비스워커)은 오래 살아있다는 보장이 없어서, 확장 안에서 몇 분을 기다리면
 * 워커가 재시작될 때 결과가 증발한다. 그래서 확장에는 짧은 작업(입력·전송·읽기)만 시키고
 * 긴 대기는 죽지 않는 이 서버가 맡는다.
 *
 * @param {function} read  () => Promise<{reply, count, streaming}>
 */
async function waitForReply(read, { before, deadlineMs = 240000, everyMs = 1500 } = {}) {
  const until = Date.now() + deadlineMs;
  let prev = '';
  let stable = 0;
  let grew = false;

  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, everyMs));
    let cur;
    try { cur = await read(); }
    catch { continue; }   // 탭이 잠깐 안 잡히는 건 넘어간다

    const text = (cur && cur.reply) || '';
    if ((cur && cur.count > before.count) || (text && text !== before.reply)) grew = true;
    if (!grew) continue;

    if (cur && cur.streaming) { stable = 0; prev = text; continue; }
    if (text && text === prev) {
      stable++;
      if (stable >= 2) return text;   // 3초간 변화 없고 스트리밍 표시도 없음
    } else {
      stable = 0;
    }
    prev = text;
  }
  return prev;
}

/** 크롬 탭 하나를 대상으로 하는 어댑터 (제미나이 / 지피티 / claude.ai 공용) */
function tabAdapter({ id, provider, label, hostMatch }) {
  return {
    id, provider, label,
    kind: 'ui',
    agentType: 'chat',
    capabilities: { streaming: false, tools: false, history: false, threads: true },
    setupHint: `크롬 확장을 설치하고 ${hostMatch} 탭을 열어두세요.`,

    async health() {
      if (!bridge.isOnline()) {
        return { ok: false, reason: '크롬 확장이 연결되어 있지 않습니다', code: 'unavailable' };
      }
      const n = store.state.tabs.filter((t) => (t.url || '').includes(hostMatch)).length;
      return n
        ? { ok: true, tabs: n }
        : { ok: false, reason: `${hostMatch} 탭이 열려 있지 않습니다`, code: 'not_found' };
    },

    async listThreads() {
      return store.state.tabs
        .filter((t) => (t.url || '').includes(hostMatch))
        .map((t) => ({
          id: String(t.id),
          title: t.title || '(제목 없음)',
          updatedAt: 0,
          meta: { url: t.url, active: t.active },
        }));
    },

    /** threadId 는 크롬 탭 id */
    async send({ threadId, text } = {}) {
      const tabId = Number(threadId);
      if (!tabId) {
        throw new AdapterError('bad_request', '대상 탭을 골라 주세요', { provider, adapterId: id });
      }
      const read = () => bridge.send('read', { tabId }, 15000);
      try {
        const before = await read();
        await bridge.send('send', { tabId, text }, 30000);   // 입력·전송만. 짧다.
        const reply = await waitForReply(read, { before });
        return {
          text: reply || '(응답을 읽지 못했습니다)',
          threadId: String(tabId), usage: null, toolCalls: [],
        };
      } catch (e) {
        throw normalize(e, id, provider);
      }
    },
  };
}

/** ChatGPT 데스크톱 앱 (CDP). Claude 앱은 디버그 연결을 거부하므로 대상이 아니다. */
const chatgptApp = {
  id: 'chatgpt-app',
  provider: 'openai',
  label: 'ChatGPT (데스크톱 앱)',
  kind: 'ui',
  agentType: 'chat',
  capabilities: { streaming: false, tools: false, history: false, threads: false },
  setupHint: 'connect-chatgpt-app.cmd 를 탐색기에서 실행해 앱을 디버그 모드로 띄우세요.',

  async health() {
    const snap = await appBridge.snapshot();
    const app = snap.find((a) => a.id === 'chatgpt');
    return app && app.connected
      ? { ok: true, title: app.title }
      : { ok: false, reason: 'ChatGPT 앱이 디버그 모드로 떠 있지 않습니다', code: 'unavailable' };
  },

  async listThreads() {
    const snap = await appBridge.snapshot();
    const app = snap.find((a) => a.id === 'chatgpt');
    return app && app.connected
      ? [{ id: 'chatgpt', title: app.title || '대화창', updatedAt: 0, meta: { url: app.url } }]
      : [];
  },

  async send({ text } = {}) {
    const read = () => appBridge.run('chatgpt', 'read');
    try {
      const before = await read();
      await appBridge.run('chatgpt', 'send', text);
      const reply = await waitForReply(read, { before });
      return {
        text: reply || '(응답을 읽지 못했습니다)',
        threadId: 'chatgpt', usage: null, toolCalls: [],
      };
    } catch (e) {
      throw normalize(e, 'chatgpt-app', 'openai');
    }
  },
};

module.exports = {
  claudeTab: register(tabAdapter({
    id: 'claude-tab', provider: 'anthropic', label: 'Claude (웹 탭)', hostMatch: 'claude.ai',
  })),
  geminiTab: register(tabAdapter({
    id: 'gemini-tab', provider: 'google', label: 'Gemini (웹 탭)', hostMatch: 'gemini.google.com',
  })),
  chatgptTab: register(tabAdapter({
    id: 'chatgpt-tab', provider: 'openai', label: 'ChatGPT (웹 탭)', hostMatch: 'chatgpt.com',
  })),
  chatgptApp: register(chatgptApp),
};
