import { pageAgent } from './pageAgent.js';

// FleetView Bridge — 크롬 쪽 에이전트
// 1) 모든 창/탭 현황을 서버로 밀어넣는다
// 2) 서버를 롱폴링하며 명령(focus / send / sendAndWait / read / open)을 실행한다

const SERVER = 'http://127.0.0.1:7777';

// ---------- 탭 보고 ----------------------------------------------------------
function providerOf(url = '') {
  if (url.includes('claude.ai')) return 'claude';
  if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) return 'chatgpt';
  if (url.includes('gemini.google.com')) return 'gemini';
  return null;
}

let reportTimer = null;
function scheduleReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(reportTabs, 250);
}

async function reportTabs() {
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    const windows = [];
    const tabs = [];
    for (const w of wins) {
      if (w.type !== 'normal' && w.type !== 'popup') continue;
      windows.push({
        id: w.id,
        focused: w.focused,
        state: w.state,
        tabCount: (w.tabs || []).length,
      });
      for (const t of w.tabs || []) {
        tabs.push({
          id: t.id,
          windowId: w.id,
          title: t.title || '',
          url: t.url || '',
          favIconUrl: t.favIconUrl || '',
          active: !!t.active,
          audible: !!t.audible,
          discarded: !!t.discarded,
          index: t.index,
          provider: providerOf(t.url || ''),
        });
      }
    }
    await fetch(SERVER + '/api/ext/tabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tabs, windows }),
    });
  } catch (e) {
    /* 서버가 아직 안 떠 있으면 조용히 넘어간다 */
  }
}

for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onActivated', 'onDetached', 'onAttached']) {
  if (chrome.tabs[ev]) chrome.tabs[ev].addListener(scheduleReport);
}
chrome.windows.onFocusChanged.addListener(scheduleReport);
chrome.windows.onCreated.addListener(scheduleReport);
chrome.windows.onRemoved.addListener(scheduleReport);

chrome.action.onClicked.addListener(async () => {
  const [existing] = await chrome.tabs.query({ url: SERVER + '/*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: SERVER + '/' });
  }
});

// 서비스 워커가 잠들어도 주기적으로 깨워 보고/폴링을 재개시킨다
chrome.alarms.create('fv-tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { scheduleReport(); pump(); });

// ---------- 명령 실행 ---------------------------------------------------------
async function runInTab(tabId, action, text) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: pageAgent,
    args: [action, text || ''],
  });
  return res.result;
}

async function execute(cmd) {
  const { action, payload } = cmd;
  if (action === 'focus') {
    const tab = await chrome.tabs.get(payload.tabId);
    await chrome.tabs.update(payload.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
    return { focused: true };
  }
  if (action === 'reportTabs') {
    await reportTabs();
    return { reported: true };
  }
  if (action === 'open') {
    const tab = await chrome.tabs.create({ url: payload.url, active: true });
    return { tabId: tab.id };
  }
  if (action === 'send' || action === 'sendAndWait' || action === 'read') {
    return runInTab(payload.tabId, action === 'sendAndWait' ? 'sendAndWait' : action, payload.text);
  }
  throw new Error('알 수 없는 명령: ' + action);
}

async function report(id, promise) {
  let body;
  try { body = { id, ok: true, data: await promise }; }
  catch (e) { body = { id, ok: false, error: e && e.message ? e.message : String(e) }; }
  try {
    await fetch(SERVER + '/api/ext/result', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {}
}

// ---------- 롱폴링 루프 -------------------------------------------------------
let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      let data;
      try {
        const r = await fetch(SERVER + '/api/ext/poll');
        data = await r.json();
      } catch {
        await new Promise((r) => setTimeout(r, 3000)); // 서버가 꺼져 있으면 재시도
        continue;
      }
      scheduleReport(); // 폴링 사이클마다 현황을 갱신해 둔다 (서버 재시작 대비)
      for (const cmd of data.commands || []) report(cmd.id, execute(cmd));
    }
  } finally {
    pumping = false;
  }
}

chrome.runtime.onStartup.addListener(() => { scheduleReport(); pump(); });
chrome.runtime.onInstalled.addListener(() => { scheduleReport(); pump(); });
scheduleReport();
pump();
