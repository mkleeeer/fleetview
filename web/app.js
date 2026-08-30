'use strict';

// ---------------------------------------------------------------- 유틸
const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const api = async (path, body) => {
  const r = await fetch(path, body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.ok === false) throw new Error(j.error || '요청 실패');
  return j;
};
const ago = (ts) => {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + '초 전';
  if (s < 3600) return Math.floor(s / 60) + '분 전';
  if (s < 86400) return Math.floor(s / 3600) + '시간 전';
  return Math.floor(s / 86400) + '일 전';
};
const PROVIDER_LABEL = { claude: '클로드', gemini: '제미나이', chatgpt: '지피티' };
const STATUS_LABEL = {
  working: '작업중', waiting: '내 차례', idle: '대기', stale: '멈춤', active: '활성',
  pending: '대기', running: '실행중', done: '완료', error: '오류', 'awaiting-human': '사람 차례',
};

// ---------------------------------------------------------------- 상태
let S = { tabs: [], windows: [], claude: [], apps: [], adapters: [], cards: [], workflows: [], extOnline: false };
let drawer = null;   // { key, kind, ref, title, sub, provider }
let busyKeys = new Set();

// ---------------------------------------------------------------- 세션 목록 만들기
function sessions() {
  const out = [];
  for (const c of S.claude) {
    out.push({
      key: 'cc:' + c.id, kind: 'claude-code', ref: c.id, provider: 'claude',
      title: c.title,
      sub: (c.channel ? '채널 · ' : '') + c.projectName + ' · ' + ago(c.updatedAt)
        + (c.lastTool ? ' · ' + c.lastTool : ''),
      status: c.status, updatedAt: c.updatedAt, detail: c,
    });
  }
  for (const a of S.apps || []) {
    const unsupported = a.debugSupported === false;
    out.push({
      key: a.key, kind: 'app', ref: a.id, provider: a.provider,
      title: a.connected ? (a.title || a.label) : a.label,
      sub: unsupported ? '데스크톱 앱 · 연결 불가 (앱이 디버그 연결을 차단)'
        : a.connected ? '데스크톱 앱 · 연결됨'
        : '데스크톱 앱 · 연결 안 됨 (클릭 후 앱 연결)',
      status: a.connected ? 'active' : 'stale',
      updatedAt: Number.MAX_SAFE_INTEGER, detail: a,
    });
  }
  for (const t of S.tabs) {
    if (!t.provider) continue;
    out.push({
      key: 'tab:' + t.id, kind: 'tab', ref: t.id, provider: t.provider,
      title: t.title || '(제목 없음)', sub: '크롬 탭' + (t.active ? ' · 활성' : ''),
      status: t.active ? 'active' : 'idle', updatedAt: 0, detail: t,
    });
  }
  return out;
}

// ---------------------------------------------------------------- 렌더: 상단
function renderTop() {
  const ext = $('#extPill');
  ext.textContent = S.extOnline ? '확장 연결됨' : '확장 미연결';
  ext.className = 'pill ' + (S.extOnline ? 'on' : 'off');
  $('#ccPill').textContent = 'Claude Code ' + S.claude.length;
}

// ---------------------------------------------------------------- 렌더: 세션 레인
function sessionCard(s) {
  const card = el('div', 'card');
  const top = el('div', 'card-top');
  top.appendChild(el('span', 'st ' + s.status, STATUS_LABEL[s.status] || s.status));
  top.appendChild(el('span', 'card-title', s.title));
  const go = el('button', 'go', '→');
  go.title = '이 화면으로 이동';
  go.onclick = (e) => { e.stopPropagation(); jumpTo(s); };
  top.appendChild(go);
  card.appendChild(top);
  card.appendChild(el('div', 'card-sub', s.sub));
  if (busyKeys.has(s.key)) {
    const b = el('div', 'card-sub');
    b.appendChild(el('span', 'spinner'));
    b.appendChild(document.createTextNode(' 응답 기다리는 중…'));
    card.appendChild(b);
  }
  card.onclick = () => openDrawer(s);
  return card;
}

function renderLanes() {
  const all = sessions();
  for (const p of ['claude', 'gemini', 'chatgpt']) {
    const body = $('#lane' + p[0].toUpperCase() + p.slice(1));
    const list = all.filter((s) => s.provider === p)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    body.textContent = '';
    $('#cnt' + p[0].toUpperCase() + p.slice(1)).textContent = list.length;
    if (!list.length) {
      const e = el('div', 'card-sub', p === 'claude'
        ? 'Claude Code 세션이나 claude.ai 탭이 없습니다'
        : PROVIDER_LABEL[p] + ' 탭을 열면 여기에 표시됩니다');
      body.appendChild(e);
      continue;
    }
    for (const s of list) body.appendChild(sessionCard(s));
  }
}


// ---------------------------------------------------------------- 렌더: 어댑터
const KIND_NOTE = {
  api: '공식 API — 안정적, 별도 과금',
  cli: '공식 CLI — 안정적, 구독 사용',
  ui: 'UI 자동화 — 구독 사용, 사이트 개편 시 깨질 수 있음',
};
const CAP_LABEL = { streaming: '스트리밍', tools: '도구', history: '이력', createThread: '새 대화' };

function renderAdapters() {
  const wrap = $('#adapters');
  if (!wrap) return;
  wrap.textContent = '';
  const list = S.adapters || [];
  if (!list.length) {
    wrap.appendChild(el('div', 'card-sub', '어댑터 상태를 불러오는 중…'));
    return;
  }
  for (const a of list) {
    const box = el('div', 'ad' + (a.health.ok ? '' : ' down'));

    const top = el('div', 'ad-top');
    top.appendChild(el('span', 'ad-name', a.label));
    const kind = el('span', 'kind ' + a.kind, a.kind);
    kind.title = KIND_NOTE[a.kind] || '';
    top.appendChild(kind);
    const at = el('span', 'atype ' + (a.agentType || 'chat'),
      a.agentType === 'coding' ? '코딩' : '대화');
    at.title = a.agentType === 'coding'
      ? '파일 수정·명령 실행까지 가능'
      : '질문과 답변만 주고받음';
    top.appendChild(at);
    box.appendChild(top);

    box.appendChild(el('div', 'ad-state ' + (a.health.ok ? 'ok' : 'no'),
      a.health.ok ? '연결됨' : (a.health.reason || '연결 안 됨')));

    const caps = el('div', 'ad-caps');
    for (const k of ['streaming', 'tools', 'history', 'createThread']) {
      caps.appendChild(el('span', 'cap' + (a.capabilities[k] ? ' on' : ''), CAP_LABEL[k]));
    }
    box.appendChild(caps);

    if (!a.health.ok && a.setupHint) box.appendChild(el('div', 'ad-hint', a.setupHint));
    wrap.appendChild(box);
  }
}

// ---------------------------------------------------------------- 렌더: 크롬 창
function renderWindows() {
  const wrap = $('#windows');
  wrap.textContent = '';
  if (!S.extOnline || !S.windows.length) {
    $('#winEmpty').classList.remove('hidden');
    return;
  }
  $('#winEmpty').classList.add('hidden');
  S.windows.forEach((w, i) => {
    const box = el('div', 'win');
    const head = el('div', 'win-head');
    head.appendChild(document.createTextNode('창 ' + (i + 1) + ' · 탭 ' + w.tabCount + (w.focused ? ' · 지금 보고 있음' : '')));
    box.appendChild(head);
    for (const t of S.tabs.filter((x) => x.windowId === w.id)) {
      const row = el('div', 'tab' + (t.active ? ' active' : ''));
      if (t.favIconUrl) {
        const img = el('img');
        img.src = t.favIconUrl;
        img.onerror = () => img.remove();
        row.appendChild(img);
      }
      row.appendChild(el('span', 't', t.title || t.url));
      let host = '';
      try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch {}
      row.appendChild(el('span', 'h', host));
      row.onclick = () => api('/api/tab/focus', { tabId: t.id }).catch(alertErr);
      box.appendChild(row);
    }
    wrap.appendChild(box);
  });
}

// ---------------------------------------------------------------- 렌더: 워크플로우
function targetOptions(current) {
  const opts = [{ v: 'manual:', label: '— 사람이 직접 —' }];
  for (const c of S.claude) {
    opts.push({ v: 'claude-code:' + c.id, label: '클로드코드 · ' + c.projectName + ' · ' + c.title.slice(0, 24) });
  }
  for (const a of S.adapters || []) {
    if (!a.health.ok) continue;
    opts.push({
      v: 'adapter:' + a.id,
      label: `${a.label} [${a.agentType === 'coding' ? '코딩' : '대화'}]`,
    });
  }
  for (const t of S.tabs) {
    if (!t.provider) continue;
    opts.push({ v: 'tab:' + t.id, label: PROVIDER_LABEL[t.provider] + ' 탭 · ' + (t.title || '').slice(0, 30) });
  }
  // 현재 배정 대상이 사라졌어도 선택지가 비지 않도록 유지
  const cur = current.type + ':' + (current.ref == null ? '' : current.ref);
  if (!opts.some((o) => o.v === cur)) opts.push({ v: cur, label: (current.label || '없어진 대상') + ' (연결 끊김)' });
  return opts;
}

function stageEl(wf, st, idx) {
  const box = el('div', 'stage ' + st.status);
  box.dataset.stage = st.id;

  const top = el('div', 'stage-top');
  const name = el('input', 'stage-name');
  name.value = st.name;
  name.dataset.k = 'name:' + st.id;
  name.onchange = () => api('/api/wf/stage/update', { wfId: wf.id, stageId: st.id, name: name.value });
  top.appendChild(name);
  const prov = st.target.type === 'claude-code' ? 'claude' : (st.target.provider || '');
  if (prov) top.appendChild(el('span', 'badge ' + prov, PROVIDER_LABEL[prov] || prov));
  top.appendChild(el('span', 'badge ' + (st.status === 'awaiting-human' ? 'awaiting' : st.status),
    STATUS_LABEL[st.status] || st.status));
  box.appendChild(top);

  const asg = el('div', 'assignee');
  const sel = el('select');
  sel.dataset.k = 'target:' + st.id;
  for (const o of targetOptions(st.target)) {
    const op = el('option', null, o.label);
    op.value = o.v;
    sel.appendChild(op);
  }
  sel.value = st.target.type + ':' + (st.target.ref == null ? '' : st.target.ref);
  sel.onchange = () => {
    const [type, ...rest] = sel.value.split(':');
    const refRaw = rest.join(':');
    const ref = type === 'tab' ? Number(refRaw) : (refRaw || null);
    const provider = type === 'claude-code' ? 'claude'
      : type === 'app' ? ((S.apps || []).find((a) => a.id === ref) || {}).provider || ''
      : (S.tabs.find((t) => t.id === ref) || {}).provider || '';
    api('/api/wf/stage/update', {
      wfId: wf.id, stageId: st.id,
      target: { type, ref, provider, label: sel.options[sel.selectedIndex].text },
    });
  };
  asg.appendChild(sel);
  box.appendChild(asg);

  const ta = el('textarea');
  ta.value = st.prompt;
  ta.placeholder = idx === 0
    ? '이 단계에서 시킬 일. 예) 다음 주제로 유튜브 소재 자료를 모아줘: …'
    : '이 단계에서 시킬 일. {{input}} 이라고 쓰면 앞 단계 결과가 들어갑니다.';
  ta.dataset.k = 'prompt:' + st.id;
  ta.onchange = () => api('/api/wf/stage/update', { wfId: wf.id, stageId: st.id, prompt: ta.value });
  box.appendChild(ta);

  const foot = el('div', 'stage-foot');
  const runBtn = el('button', 'btn sm', st.status === 'running' ? '실행중…' : '이 단계 실행');
  runBtn.disabled = st.status === 'running';
  runBtn.onclick = () => api('/api/wf/stage/run', { wfId: wf.id, stageId: st.id }).catch(alertErr);
  foot.appendChild(runBtn);

  const autoWrap = el('label', 'card-sub');
  const auto = el('input');
  auto.type = 'checkbox';
  auto.checked = !!st.auto;
  auto.onchange = () => api('/api/wf/stage/update', { wfId: wf.id, stageId: st.id, auto: auto.checked });
  autoWrap.appendChild(auto);
  autoWrap.appendChild(document.createTextNode(' 자동'));
  foot.appendChild(autoWrap);

  foot.appendChild(el('span', 'spacer'));
  const del = el('button', 'btn sm ghost danger', '삭제');
  del.onclick = () => api('/api/wf/stage/delete', { wfId: wf.id, stageId: st.id }).catch(alertErr);
  foot.appendChild(del);
  box.appendChild(foot);

  if (st.status === 'awaiting-human') {
    const manual = el('textarea');
    manual.placeholder = '사람이 처리한 결과를 여기에 붙여넣고 아래 버튼을 누르면 다음 단계로 넘어갑니다';
    box.appendChild(manual);
    const done = el('button', 'btn sm primary', '결과 제출하고 다음 단계로');
    done.onclick = () => api('/api/wf/stage/complete', { wfId: wf.id, stageId: st.id, output: manual.value }).catch(alertErr);
    box.appendChild(done);
  }

  if (st.error) box.appendChild(el('div', 'out err', st.error));
  else if (st.output) {
    const out = el('div', 'out', st.output);
    out.title = '클릭하면 전체 보기';
    out.onclick = () => showOutput(st);
    box.appendChild(out);
  }
  return box;
}

function renderWorkflows() {
  const wrap = $('#workflows');
  wrap.textContent = '';
  $('#wfEmpty').classList.toggle('hidden', S.workflows.length > 0);

  for (const wf of S.workflows) {
    const box = el('div', 'wf');
    const head = el('div', 'wf-head');
    const name = el('input', 'wf-name');
    name.value = wf.name;
    name.dataset.k = 'wfname:' + wf.id;
    name.onchange = () => api('/api/wf/update', { id: wf.id, name: name.value }).catch(alertErr);
    head.appendChild(name);
    const doneCount = wf.stages.filter((s) => s.status === 'done').length;
    head.appendChild(el('span', 'badge', doneCount + '/' + wf.stages.length + ' 완료'));
    head.appendChild(el('span', 'spacer'));

    const runAll = el('button', 'btn sm primary', wf.running ? '실행중…' : '처음부터 실행');
    runAll.onclick = () => api('/api/wf/start', { id: wf.id }).catch(alertErr);
    head.appendChild(runAll);
    if (wf.running) {
      const stop = el('button', 'btn sm', '중단');
      stop.onclick = () => api('/api/wf/stop', { id: wf.id }).catch(alertErr);
      head.appendChild(stop);
    }
    const addSt = el('button', 'btn sm', '+ 단계');
    addSt.onclick = () => api('/api/wf/stage/add', { wfId: wf.id }).catch(alertErr);
    head.appendChild(addSt);
    const delWf = el('button', 'btn sm ghost danger', '작업 삭제');
    delWf.onclick = () => { if (confirm('작업 「' + wf.name + '」을 삭제할까요?')) api('/api/wf/delete', { id: wf.id }); };
    head.appendChild(delWf);
    box.appendChild(head);

    const pipe = el('div', 'pipe');
    wf.stages.forEach((st, i) => {
      if (i) pipe.appendChild(el('div', 'arrow', '→'));
      pipe.appendChild(stageEl(wf, st, i));
    });
    if (!wf.stages.length) {
      pipe.appendChild(el('div', 'empty', '단계가 없습니다. + 단계 를 눌러 「수집 → 분석 → 대본」처럼 만들어 보세요.'));
    }
    box.appendChild(pipe);
    wrap.appendChild(box);
  }
}

function showOutput(st) {
  const w = window.open('', '_blank', 'width=760,height=620');
  w.document.title = st.name + ' 산출물';
  w.document.body.style.cssText = 'background:#0e1116;color:#e6edf3;font:14px/1.6 sans-serif;padding:24px;white-space:pre-wrap';
  w.document.body.textContent = st.output;
}

// ---------------------------------------------------------------- 이동 / 드로어
async function jumpTo(s) {
  try {
    if (s.kind === 'tab') await api('/api/tab/focus', { tabId: s.ref });
    else if (s.kind === 'app') await api('/api/app/focus', { app: s.ref });
    else await api('/api/claude/open-terminal', { sessionId: s.ref });
  } catch (e) { alertErr(e); }
}

async function openDrawer(s) {
  drawer = s;
  $('#drawerTitle').textContent = s.title;
  $('#drawerSub').textContent = (PROVIDER_LABEL[s.provider] || '') + ' · ' + s.sub;
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
  const goBtn = $('#drawerGo');
  const unsupported = s.kind === 'app' && s.detail.debugSupported === false;
  const needConnect = s.kind === 'app' && !s.detail.connected && !unsupported;
  goBtn.textContent = unsupported ? 'claude.ai 탭 열기'
    : needConnect ? '앱 연결' : '→ 이 화면으로 이동';
  goBtn.className = (unsupported || needConnect) ? 'btn primary' : 'btn';
  $('#chatSend').disabled = needConnect || (unsupported && !s.detail.connected);
  const warn = $('#drawerWarn');
  if (s.kind === 'app') {
    warn.textContent = s.detail.debugSupported === false
      ? s.detail.note
      : s.detail.connected
      ? '데스크톱 앱의 대화창에 직접 입력하고 전송합니다.'
      : '앱이 아직 디버그 모드로 떠 있지 않습니다. 아래 「앱 연결」을 누르면 앱을 껐다 다시 띄웁니다. 대화 내용은 사라지지 않습니다.';
    warn.classList.remove('hidden');
  } else if (s.kind === 'claude-code') {
    warn.textContent = s.detail.channel
      ? '이 세션에는 채널이 붙어 있습니다. 보낸 메시지가 실행 중인 그 창으로 바로 들어가고, 답도 그 창에 남습니다.'
      : '이 세션에는 채널이 붙어 있지 않습니다. 여기서 보내면 새 프로세스가 떠서 답이 이 창에만 남고 세션 기록에는 곁가지로 갈라집니다. '
        + '갈라지지 않게 하려면 그 세션을 채널과 함께 다시 시작하세요: claude --resume <세션id> --dangerously-load-development-channels server:fleetview';
    warn.classList.remove('hidden');
  } else {
    warn.textContent = '이 탭의 입력창에 직접 입력하고 전송합니다. 탭을 닫거나 이동시키지 마세요.';
    warn.classList.remove('hidden');
  }
  await loadTranscript(s.key);
}

async function loadTranscript(key) {
  const chat = $('#chat');
  chat.textContent = '';
  try {
    const j = await api('/api/transcript?key=' + encodeURIComponent(key));
    if (!j.entries.length) chat.appendChild(el('div', 'msg sys', '아직 이 대시보드에서 주고받은 내용이 없습니다.'));
    for (const e of j.entries) appendMsg(e);
  } catch (e) { alertErr(e); }
}

function appendMsg(e) {
  const chat = $('#chat');
  const m = el('div', 'msg ' + e.role, e.text);
  chat.appendChild(m);
  chat.scrollTop = chat.scrollHeight;
}

async function sendChat() {
  if (!drawer) return;
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendMsg({ role: 'user', text });
  const pending = el('div', 'msg assistant');
  pending.appendChild(el('span', 'spinner'));
  pending.appendChild(document.createTextNode(' 응답 기다리는 중…'));
  $('#chat').appendChild(pending);
  $('#chat').scrollTop = $('#chat').scrollHeight;
  busyKeys.add(drawer.key);
  renderLanes();
  try {
    const r = drawer.kind === 'claude-code'
      // 채널이 붙어 있으면 실행 중인 그 세션으로 직접 넣는다(곁가지 없음).
      // 없으면 예전 방식으로 새 프로세스를 띄운다.
      ? drawer.detail.channel
        ? await api('/api/adapters/send', { id: 'claude-channel', threadId: drawer.ref, text })
        : await api('/api/claude/send', { sessionId: drawer.ref, text })
      : drawer.kind === 'app'
      ? await api('/api/app/send', { app: drawer.ref, text })
      : await api('/api/tab/send', { tabId: drawer.ref, text });
    pending.remove();
    appendMsg({ role: 'assistant', text: r.reply || '(빈 응답)' });
  } catch (e) {
    pending.remove();
    appendMsg({ role: 'sys', text: '실패: ' + e.message });
  } finally {
    busyKeys.delete(drawer.key);
    renderLanes();
  }
}

function closeDrawer() {
  drawer = null;
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('open');
}

const alertErr = (e) => alert(e && e.message ? e.message : String(e));

// ---------------------------------------------------------------- 렌더 진입점
function renderAll() {
  // 편집 중인 입력은 덮어쓰지 않도록 포커스를 되돌려 준다
  const act = document.activeElement;
  const k = act && act.dataset ? act.dataset.k : null;
  const pos = act && act.selectionStart;

  renderTop();
  renderWorkflows();
  renderAdapters();
  renderLanes();
  renderWindows();

  if (k) {
    const back = document.querySelector('[data-k="' + k + '"]');
    if (back) {
      back.focus();
      try { back.setSelectionRange(pos, pos); } catch {}
    }
  }
}

// ---------------------------------------------------------------- 이벤트 배선
$('#btnNewTask').onclick = async () => {
  const name = prompt('작업 이름 (예: 유튜브 영상 만들기)');
  if (!name) return;
  const wf = await api('/api/wf/create', { name });
  await api('/api/wf/stage/add', { wfId: wf.id, name: '수집' });
  await api('/api/wf/stage/add', { wfId: wf.id, name: '분석', prompt: '아래 수집 결과를 분석해줘.\n\n{{input}}' });
  await api('/api/wf/stage/add', { wfId: wf.id, name: '정리', prompt: '아래 분석을 바탕으로 최종본을 만들어줘.\n\n{{input}}' });
};
$('#drawerClose').onclick = closeDrawer;
$('#scrim').onclick = closeDrawer;
$('#drawerGo').onclick = async () => {
  if (!drawer) return;
  if (drawer.kind === 'app' && drawer.detail.debugSupported === false) {
    try {
      await api('/api/tab/open', { url: 'https://claude.ai/' });
      closeDrawer();
    } catch (e) { alertErr(e); }
    return;
  }
  if (drawer.kind === 'app' && !drawer.detail.connected) {
    const btn = $('#drawerGo');
    btn.disabled = true;
    btn.textContent = '앱 다시 띄우는 중…';
    try {
      await api('/api/app/connect', { app: drawer.ref });
      btn.textContent = '→ 이 화면으로 이동';
      btn.className = 'btn';
      $('#chatSend').disabled = false;
      $('#drawerWarn').textContent = '연결됐습니다. 이제 여기서 바로 보낼 수 있습니다.';
    } catch (e) {
      btn.textContent = '앱 연결';
      alertErr(e);
    } finally { btn.disabled = false; }
    return;
  }
  jumpTo(drawer);
};
$('#chatSend').onclick = sendChat;
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ---------------------------------------------------------------- SSE
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (ev) => { S = JSON.parse(ev.data); renderAll(); });
  es.addEventListener('busy', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.busy) busyKeys.add(d.key); else busyKeys.delete(d.key);
    renderLanes();
  });
  es.addEventListener('transcript', (ev) => {
    const d = JSON.parse(ev.data);
    if (drawer && d.key === drawer.key) { /* 전송 흐름에서 이미 그렸으므로 생략 */ }
  });
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}
connect();
setInterval(() => { if (S.claude.length) renderLanes(); }, 15000); // '몇 분 전' 갱신
