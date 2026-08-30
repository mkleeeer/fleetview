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
  open: '사용중',        // 터미널이나 앱에서 지금 열려 있는 세션
  pending: '대기', running: '실행중', done: '완료', error: '오류', 'awaiting-human': '사람 차례',
};

// ---------------------------------------------------------------- 상태
let S = { tabs: [], windows: [], claude: [], apps: [], adapters: [], cards: [], workflows: [], extOnline: false };
let drawer = null;   // { key, kind, ref, title, sub, provider }
let busyKeys = new Set();
let connState = 'connecting';
let adaptersOpen = false;   // 연결 섹션은 기본으로 접어 둔다   // connecting | live | lost — 로딩과 고장을 구분하기 위해

// ---------------------------------------------------------------- 세션 목록 만들기
function sessions() {
  const out = [];
  for (const c of S.claude) {
    out.push({
      key: 'cc:' + c.id, kind: 'claude-code', ref: c.id, provider: 'claude',
      surface: 'app',
      title: c.title,
      sub: (c.channel ? '● 연결됨 · ' : '') + c.projectName + ' · ' + ago(c.updatedAt)
        + (c.lastTool ? ' · ' + c.lastTool : ''),
      status: c.status, updatedAt: c.updatedAt, detail: c,
    });
  }
  for (const a of S.apps || []) {
    const unsupported = a.debugSupported === false;
    out.push({
      key: a.key, kind: 'app', ref: a.id, provider: a.provider,
      surface: 'app',
      title: a.connected ? (a.title || a.label) : a.label,
      sub: unsupported ? '데스크톱 앱 · 연결 불가 (앱이 디버그 연결을 차단)'
        : a.connected ? '데스크톱 앱 · 연결됨'
        : '데스크톱 앱 · 연결 안 됨 (클릭 후 앱 연결)',
      status: a.connected ? 'active' : 'stale',
      updatedAt: Number.MAX_SAFE_INTEGER, detail: a,
    });
  }
  for (const c of S.codex || []) {
    const age = c.updatedAt ? Date.now() - c.updatedAt : Infinity;
    out.push({
      key: 'codex:' + c.id, kind: 'codex', ref: c.id, provider: 'chatgpt',
      surface: 'app',
      title: c.title,
      sub: 'Codex · ' + (c.updatedAt ? ago(c.updatedAt) : '시각 모름'),
      // Codex 는 실행 중인지 알 방법이 없어 최근 활동으로만 가른다
      status: age < 30 * 60 * 1000 ? 'idle' : 'stale',
      updatedAt: c.updatedAt || 0, detail: c,
    });
  }
  for (const t of S.tabs) {
    if (!t.provider) continue;
    out.push({
      key: 'tab:' + t.id, kind: 'tab', ref: t.id, provider: t.provider,
      surface: 'tab',
      title: t.title || '(제목 없음)', sub: '크롬 탭' + (t.active ? ' · 활성' : ''),
      status: t.active ? 'active' : 'idle', updatedAt: 0, detail: t,
    });
  }
  return out;
}

// ---------------------------------------------------------------- 렌더: 상단
function renderTop() {
  const conn = $('#connPill');
  if (conn) {
    conn.textContent = { connecting: '연결 중…', live: '실시간', lost: '서버 끊김' }[connState];
    conn.className = 'pill ' + (connState === 'live' ? 'on' : connState === 'lost' ? 'off' : '');
  }
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
  go.title = s.kind === 'claude-code'
    ? (s.detail.live ? '이 세션이 열려 있는 창을 앞으로' : '이 세션을 터미널에서 이어서 열기')
    : '이 화면으로 이동';
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

/** 채널을 붙인 Claude Code 세션을 새로 띄운다 */
async function launchSession(resumeId) {
  const NL = String.fromCharCode(10);   // 소스에 이스케이프를 쓰지 않는다

  let folders = [];
  try { folders = (await api('/api/session/folders')).folders; } catch {}

  const list = folders.map((f, i) => `${i + 1}. ${f.name}  (${f.path})`).join(NL);
  const head = resumeId
    ? '이 세션을 새 창에서 다시 엽니다. 그 창은 대시보드와 연결됩니다.'
    : '새 클로드 창을 띄웁니다. 그 창은 대시보드와 연결됩니다.';
  const pick = prompt(
    head + NL + NL + '폴더 번호를 고르거나 경로를 직접 입력하세요.' + NL + NL + list,
    folders.length ? '1' : '');
  if (!pick) return;

  const n = Number(pick);
  const cwd = (n >= 1 && n <= folders.length) ? folders[n - 1].path : pick.trim();

  const btn = $('#btnNewSession');
  const label = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '띄우는 중…'; }
  try {
    const r = await api('/api/session/launch', { cwd, resumeId });
    if (r.ok === false) throw new Error(r.error);
    alert('창이 열렸고 대시보드와 연결됐습니다.' + NL + NL
      + '이제 여기서 보내는 메시지가 그 창에 바로 뜹니다.');
  } catch (e) {
    alertErr(e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

const collapsed = new Set(['claude', 'gemini', 'chatgpt']);   // 지난 세션은 기본으로 접어 둔다
const DEAD = new Set(['stale']);                              // 끝난 것으로 보는 상태

function renderGroup(body, label, list) {
  if (!list.length) return;
  const head = el('div', 'grp', label);
  head.appendChild(el('span', 'grp-n', String(list.length)));
  body.appendChild(head);
  for (const s of list) body.appendChild(sessionCard(s));
}

function renderLanes() {
  const all = sessions();
  for (const p of ['claude', 'gemini', 'chatgpt']) {
    const cap = p[0].toUpperCase() + p.slice(1);
    const body = $('#lane' + cap);
    const mine = all.filter((s) => s.provider === p);
    body.textContent = '';
    $('#cnt' + cap).textContent = mine.length;

    const live = mine.filter((s) => !DEAD.has(s.status))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const dead = mine.filter((s) => DEAD.has(s.status))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (!mine.length) {
      body.appendChild(el('div', 'card-sub',
        connState !== 'live' ? '불러오는 중…'
        : p === 'claude' ? 'Claude Code 세션이나 claude.ai 탭이 없습니다'
        : PROVIDER_LABEL[p] + ' 탭을 열면 여기에 표시됩니다'));
      continue;
    }

    // 앱으로 하는 것 / 탭으로 하는 것
    renderGroup(body, '앱', live.filter((s) => s.surface === 'app'));
    renderGroup(body, '탭', live.filter((s) => s.surface === 'tab'));

    if (dead.length) {
      const isOpen = !collapsed.has(p);
      const toggle = el('button', 'grp-toggle',
        (isOpen ? '▾ ' : '▸ ') + '지난 세션 ' + dead.length + '개');
      toggle.onclick = () => {
        if (collapsed.has(p)) collapsed.delete(p); else collapsed.add(p);
        renderLanes();
      };
      body.appendChild(toggle);
      if (isOpen) for (const s of dead) body.appendChild(sessionCard(s));
    }
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
  const list = S.adapters || [];

  // 접힌 상태에서도 문제가 있으면 한 줄로 알 수 있게 요약한다
  const summary = $('#adaptersSummary');
  const caret = $('#adaptersCaret');
  if (summary) {
    const bad = list.filter((a) => !a.health.ok).length;
    summary.textContent = !list.length ? ''
      : bad ? `— ${list.length}개 중 ${bad}개 연결 안 됨`
      : `— ${list.length}개 모두 연결됨`;
    summary.className = bad ? 'bad' : 'muted';
  }
  if (caret) caret.textContent = adaptersOpen ? '▾' : '▸';
  wrap.classList.toggle('hidden', !adaptersOpen);
  if (!adaptersOpen) return;

  wrap.textContent = '';
  if (!list.length) {
    wrap.appendChild(el('div', 'card-sub',
      connState === 'lost' ? '서버와 연결이 끊겼습니다. 서버 창을 확인해 주세요.'
        : '어댑터 상태를 불러오는 중…'));
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
    if (s.kind === 'tab') return void await api('/api/tab/focus', { tabId: s.ref });
    if (s.kind === 'codex') {
      const NL = String.fromCharCode(10);
      return void alert('Codex 세션은 터미널에서 이어가세요:' + NL + NL
        + 'codex exec resume ' + s.ref);
    }
    if (s.kind === 'app') return void await api('/api/app/focus', { app: s.ref });

    // Claude Code 세션: 살아 있으면 그 창을 띄우고, 꺼져 있으면 이어서 연다.
    const r = await api('/api/session/focus', { sessionId: s.ref });
    if (!r.live) {
      await api('/api/claude/open-terminal', { sessionId: s.ref });
      return;
    }
    if (r.note) alert(r.note);
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
  const needChannel = s.kind === 'claude-code' && !s.detail.channel;
  goBtn.textContent = unsupported ? 'claude.ai 탭 열기'
    : needConnect ? '앱 연결'
    : needChannel ? '창과 연결하기'
    : '→ 이 화면으로 이동';
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
  } else if (s.kind === 'codex') {
    warn.textContent = 'Codex CLI 로 이 세션을 이어서 실행합니다. ChatGPT 구독을 그대로 쓰며 API 과금은 없습니다.';
    warn.classList.remove('hidden');
  } else if (s.kind === 'claude-code') {
    warn.textContent = s.detail.channel
      ? '열려 있는 창과 연결됨 — 여기서 보내면 그 창에 바로 뜨고, 답도 거기 남습니다.'
      : '창과 연결 안 됨 — 여기서 보내면 클로드가 따로 하나 실행돼서 답합니다. '
        + '열려 있는 창에는 안 뜨고 답이 여기에만 남습니다. '
        + '창에서 이어가려면 아래 「창과 연결하기」를 누르세요.';
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
    const r = drawer.kind === 'codex'
      ? await api('/api/adapters/send', { id: 'codex-cli', threadId: drawer.ref, text })
      : drawer.kind === 'claude-code'
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
const adaptersToggle = document.getElementById('adaptersToggle');
if (adaptersToggle) adaptersToggle.onclick = () => { adaptersOpen = !adaptersOpen; renderAdapters(); };

const btnNewSession = document.getElementById('btnNewSession');
if (btnNewSession) btnNewSession.onclick = () => launchSession(null);
$('#drawerClose').onclick = closeDrawer;
$('#scrim').onclick = closeDrawer;
$('#drawerGo').onclick = async () => {
  if (!drawer) return;
  if (drawer.kind === 'claude-code' && !drawer.detail.channel) {
    return launchSession(drawer.ref);
  }
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
  es.addEventListener('state', (ev) => {
    connState = 'live';
    S = JSON.parse(ev.data);
    renderAll();
  });
  es.addEventListener('busy', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.busy) busyKeys.add(d.key); else busyKeys.delete(d.key);
    renderLanes();
  });
  es.addEventListener('transcript', (ev) => {
    const d = JSON.parse(ev.data);
    if (drawer && d.key === drawer.key) { /* 전송 흐름에서 이미 그렸으므로 생략 */ }
  });
  es.onerror = () => {
    connState = 'lost';
    renderTop();
    es.close();
    setTimeout(connect, 2000);
  };
}
connect();
setInterval(() => { if (S.claude.length) renderLanes(); }, 15000); // '몇 분 전' 갱신
