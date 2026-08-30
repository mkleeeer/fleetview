'use strict';
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

/**
 * 중앙 상태 저장소.
 * - tabs        : 크롬 확장이 밀어넣는 창/탭 스냅샷 (휘발성)
 * - claude      : ~/.claude/projects 스캔 결과 (휘발성)
 * - cards       : 사용자가 손으로 등록한 세션 카드 (영속)
 * - workflows   : 워크플로우 정의와 진행 상태 (영속)
 * - transcripts : 대시보드에서 주고받은 대화 로그 (휘발성, 세션별 최근 200개)
 */
const state = {
  tabs: [],
  windows: [],
  extLastSeen: 0,
  claude: [],
  codex: [],
  apps: [],
  adapters: [],
  cards: [],
  workflows: [],
  transcripts: {},
};

// ---- 영속 데이터 ----------------------------------------------------------
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state.cards = raw.cards || [];
    state.workflows = raw.workflows || [];
  } catch {
    /* 최초 실행 */
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = { cards: state.cards, workflows: state.workflows };
    fs.writeFile(DATA_FILE, JSON.stringify(out, null, 2), () => {});
  }, 200);
}

// ---- SSE 구독자 -----------------------------------------------------------
const subscribers = new Set();

function subscribe(res) {
  subscribers.add(res);
  res.on('close', () => subscribers.delete(res));
}

function broadcast(type, payload) {
  const chunk = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of subscribers) {
    try { res.write(chunk); } catch { subscribers.delete(res); }
  }
}

// 상태가 바뀔 때마다 부르면 되는 헬퍼. 짧은 시간에 여러 번 불려도 한 번만 나감.
let pushTimer = null;
function pushState() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => broadcast('state', snapshot()), 60);
}

function snapshot() {
  return {
    tabs: state.tabs,
    windows: state.windows,
    extOnline: Date.now() - state.extLastSeen < 45000,
    claude: state.claude,
    codex: state.codex,
    apps: state.apps,
    adapters: state.adapters,
    cards: state.cards,
    workflows: state.workflows,
    now: Date.now(),
  };
}

function log(sessionKey, entry) {
  const list = state.transcripts[sessionKey] || (state.transcripts[sessionKey] = []);
  list.push({ ...entry, at: Date.now() });
  if (list.length > 200) list.splice(0, list.length - 200);
  broadcast('transcript', { key: sessionKey, entry: list[list.length - 1] });
}

const uid = (p) => p + '_' + Math.random().toString(36).slice(2, 10);

module.exports = { state, load, save, subscribe, broadcast, pushState, snapshot, log, uid };
