'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const store = require('./store');
const bridge = require('./bridge');
const runner = require('./claudeRunner');
const wf = require('./workflow');
const claudeSessions = require('./claudeSessions');
const appBridge = require('./appBridge');
const adapters = require('./adapters');
const channelHub = require('./channelHub');
const launcher = require('./sessionLauncher');
const windowFocus = require('./windowFocus');
const ptyHost = require('./ptyHost');

const PORT = Number(process.env.FLEET_PORT || 7777);
const WEB = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
};
const ok = (res, body = { ok: true }) => json(res, 200, body);
const fail = (res, e, code = 400) =>
  json(res, code, { ok: false, error: e && e.message ? e.message : String(e) });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 8e6) { reject(new Error('본문이 너무 큽니다')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(WEB, rel);
  if (!file.startsWith(WEB)) return fail(res, new Error('경로 오류'), 403);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }

    let body = buf;
    // index.html 을 줄 때 js/css 주소에 수정 시각을 붙인다.
    // 그래야 파일이 바뀌었을 때 브라우저가 옛 파일을 계속 쓰지 않는다.
    if (rel === 'index.html') {
      const stamp = (name) => {
        try { return String(Math.floor(fs.statSync(path.join(WEB, name)).mtimeMs)); }
        catch { return String(Date.now()); }
      };
      body = Buffer.from(buf.toString('utf8')
        .replace('/app.js', '/app.js?v=' + stamp('app.js'))
        .replace('/style.css', '/style.css?v=' + stamp('style.css')), 'utf8');
    }

    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store, must-revalidate',
      pragma: 'no-cache',
      expires: '0',
    });
    res.end(body);
  });
}

/** 경로에서 마지막 폴더 이름만 뽑는다. 구분자는 path 모듈로 처리한다. */
const baseName = (p2) => {
  if (!p2) return '?';
  const parts = p2.split(path.sep).join('/').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '?';
};

// ---- Claude Code 세션 폴링 ------------------------------------------------
function refreshClaude() {
  const next = claudeSessions.scan();
  // 채널이 붙은 세션은 대시보드가 곁가지 없는 경로로 보낼 수 있다
  for (const s of next) s.channel = channelHub.isConnected(s.id);

  // 방금 띄운 세션은 아직 대화가 없어 기록 파일이 비어 있고, 그래서 스캔에 안 걸린다.
  // 채널은 붙었는데 화면에 카드가 없으면 쓸 수가 없으므로 여기서 채워 넣는다.
  const known = new Set(next.map((s) => s.id));
  for (const c of channelHub.live()) {
    if (known.has(c.sessionId)) continue;
    next.unshift({
      kind: 'claude-code', provider: 'claude',
      id: c.sessionId, key: 'cc:' + c.sessionId,
      title: '(새 세션 — 아직 대화 없음)',
      project: c.cwd, projectName: baseName(c.cwd),
      status: 'open', channel: true, live: true,
      lastTool: null, lastUser: '', lastAssistant: '',
      updatedAt: Date.now(), file: null,
    });
  }
  store.state.terminals = ptyHost.list();
  const sig = (list) => JSON.stringify(list.map((s) => [s.id, s.status, s.updatedAt, s.channel]));
  const changed = sig(next) !== sig(store.state.claude);
  store.state.claude = next;
  if (changed) store.pushState();
}

// ---- 라우팅 ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  // 크롬 확장(chrome-extension:// 오리진)에서 오는 요청 허용
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    // --- 상태 ---
    if (p === '/api/state') return ok(res, store.snapshot());

    if (p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      res.write('event: state\ndata: ' + JSON.stringify(store.snapshot()) + '\n\n');
      store.subscribe(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 20000);
      res.on('close', () => clearInterval(ka));
      return;
    }

    // 세션 기록 그대로 — 터미널에서 친 말과 대시보드에서 보낸 말이 한자리에 나온다
    if (p === '/api/session/history') {
      const sessionId = u.searchParams.get('sessionId');
      if (!sessionId) return ok(res, { entries: [] });
      return ok(res, { entries: claudeSessions.transcriptEntries(sessionId) });
    }

    if (p === '/api/transcript') {
      const key = u.searchParams.get('key');
      return ok(res, { entries: store.state.transcripts[key] || [] });
    }

    // --- 크롬 확장 ---
    if (p === '/api/ext/tabs' && req.method === 'POST') {
      const body = await readBody(req);
      store.state.tabs = body.tabs || [];
      store.state.windows = body.windows || [];
      store.state.extLastSeen = Date.now();
      store.pushState();
      return ok(res);
    }
    if (p === '/api/ext/poll') {
      store.state.extLastSeen = Date.now();
      // 서버가 재시작되어 탭 목록이 비었으면 확장에 다시 보고하라고 요청한다
      if (!store.state.tabs.length) bridge.push('reportTabs');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return bridge.hold(res);
    }
    if (p === '/api/ext/result' && req.method === 'POST') {
      const body = await readBody(req);
      bridge.resolveResult(body);
      return ok(res);
    }

    // --- 탭 조작 ---
    if (p === '/api/tab/focus' && req.method === 'POST') {
      const { tabId } = await readBody(req);
      await bridge.send('focus', { tabId }, 10000);
      return ok(res);
    }
    if (p === '/api/tab/send' && req.method === 'POST') {
      const { tabId, text, wait } = await readBody(req);
      const key = 'tab:' + tabId;
      store.log(key, { role: 'user', text });
      if (wait === false) {
        await bridge.send('send', { tabId, text }, 20000);
        return ok(res);
      }
      const r = await bridge.send('sendAndWait', { tabId, text });
      const reply = (r && r.reply) || '';
      store.log(key, { role: 'assistant', text: reply });
      return ok(res, { reply });
    }
    if (p === '/api/tab/read' && req.method === 'POST') {
      const { tabId } = await readBody(req);
      const r = await bridge.send('read', { tabId }, 20000);
      return ok(res, r);
    }
    if (p === '/api/tab/open' && req.method === 'POST') {
      const { url } = await readBody(req);
      await bridge.send('open', { url }, 10000);
      return ok(res);
    }

    // --- Claude Code 세션 ---
    if (p === '/api/claude/send' && req.method === 'POST') {
      const { sessionId, text } = await readBody(req);
      const cc = store.state.claude.find((c) => c.id === sessionId);
      const key = 'cc:' + sessionId;
      store.log(key, { role: 'user', text });
      store.broadcast('busy', { key, busy: true });
      try {
        const out = await runner.send(sessionId, text, { cwd: cc && cc.project });
        store.log(key, { role: 'assistant', text: out });
        refreshClaude();
        return ok(res, { reply: out });
      } finally {
        store.broadcast('busy', { key, busy: false });
      }
    }
    if (p === '/api/claude/cancel' && req.method === 'POST') {
      const { sessionId } = await readBody(req);
      return ok(res, { cancelled: runner.cancel(sessionId) });
    }
    // 그 세션을 터미널 창으로 이어서 열기
    if (p === '/api/claude/open-terminal' && req.method === 'POST') {
      const { sessionId } = await readBody(req);
      const cc = store.state.claude.find((c) => c.id === sessionId);
      const cwd = (cc && cc.project) || process.cwd();
      const inner = 'cd /d "' + cwd + '" && claude --resume ' + sessionId;
      execFile('cmd', ['/c', 'start', '"Claude"', 'cmd', '/k', inner], { windowsHide: false }, () => {});
      return ok(res);
    }

    // --- 창 없는 터미널 (가짜 터미널) ---
    if (p === '/api/pty/list') {
      return ok(res, { available: ptyHost.available(), terminals: ptyHost.list() });
    }
    if (p === '/api/pty/create' && req.method === 'POST') {
      const { cwd, resumeId, cols, rows } = await readBody(req);
      try { return ok(res, ptyHost.create({ cwd, resumeId, cols, rows })); }
      catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (p === '/api/pty/input' && req.method === 'POST') {
      const { id, data } = await readBody(req);
      try { ptyHost.write(id, data); return ok(res); }
      catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (p === '/api/pty/resize' && req.method === 'POST') {
      const { id, cols, rows } = await readBody(req);
      ptyHost.resize(id, cols, rows);
      return ok(res);
    }
    if (p === '/api/pty/buffer') {
      return ok(res, { data: ptyHost.buffer(u.searchParams.get('id')) });
    }
    if (p === '/api/pty/kill' && req.method === 'POST') {
      const { id } = await readBody(req);
      return ok(res, { killed: ptyHost.kill(id) });
    }

    // --- 세션 바로가기 (그 창을 앞으로) ---
    if (p === '/api/session/focus' && req.method === 'POST') {
      const { sessionId } = await readBody(req);
      const live = claudeSessions.liveSessions().get(sessionId);
      if (!live) {
        // 꺼져 있는 세션은 창이 없다. 이어서 열어 주는 게 맞다.
        return ok(res, { focused: false, live: false });
      }
      const r = await windowFocus.focusSessionWindow(live.pid, 'FleetView - ' + sessionId.slice(0, 8));
      return ok(res, {
        ...r, live: true, entrypoint: live.entrypoint,
        // 앱은 창이 하나라 세션별 탭까지는 못 고른다
        note: r.focused && live.entrypoint === 'claude-desktop'
          ? 'Claude 앱 창을 띄웠습니다. 앱 안에서 해당 세션 탭은 직접 골라 주세요.'
          : (!r.focused ? '창을 찾지 못했습니다. 그 세션이 열려 있는 터미널로 직접 전환해 주세요.' : ''),
      });
    }

    // --- 세션 시작 (채널을 붙여서 띄운다) ---
    if (p === '/api/session/folders') {
      return ok(res, { folders: launcher.knownFolders() });
    }
    if (p === '/api/session/launch' && req.method === 'POST') {
      const { cwd, resumeId } = await readBody(req);
      try {
        return ok(res, await launcher.launch({ cwd, resumeId }));
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message, code: e.code || 'internal' });
      }
    }

    // --- Claude Code 채널 (실행 중 세션에 직접 주입) ---
    if (p === '/api/channel/register' && req.method === 'POST') {
      const body = await readBody(req);
      return ok(res, channelHub.register(body) || {});
    }
    if (p === '/api/channel/poll') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return channelHub.hold(u.searchParams.get('sessionId'), res);
    }
    if (p === '/api/channel/reply' && req.method === 'POST') {
      const body = await readBody(req);
      return ok(res, { delivered: channelHub.reply(body) });
    }
    if (p === '/api/channel/list') return ok(res, { channels: channelHub.live() });

    // --- 어댑터 계층 ---
    // 어떤 사업자든 같은 규격으로 부른다. 인증·이력·스트리밍·도구·오류가 통일돼 있다.
    if (p === '/api/adapters') return ok(res, { adapters: await adapters.describeAll() });

    if (p === '/api/adapters/threads') {
      const a = adapters.must(u.searchParams.get('id'));
      const list = a.listThreads ? await a.listThreads() : [];
      return ok(res, { threads: list });
    }

    if (p === '/api/adapters/send' && req.method === 'POST') {
      const { id, threadId, text, stream, cwd, logKey } = await readBody(req);
      const a = adapters.must(id);
      // 대시보드 카드가 자기 이름을 넘겨주면 그 이름으로 기록한다.
      // 안 그러면 카드가 읽는 이름과 저장되는 이름이 어긋나 대화가 사라진 것처럼 보인다.
      const key = logKey || ('ad:' + id + ':' + (threadId || 'new'));
      store.log(key, { role: 'user', text });
      store.broadcast('busy', { key, busy: true });
      store.state.busy++;
      try {
        const onDelta = stream === false ? undefined
          : (chunk) => store.broadcast('delta', { key, chunk });
        const r = await a.send({ threadId, text, cwd, onDelta });
        store.log(key, { role: 'assistant', text: r.text });
        return ok(res, r);
      } catch (e) {
        // 어댑터 오류는 공통 형식으로 내려보낸다
        const body = e && e.toJSON ? e.toJSON() : { code: 'internal', message: String(e) };
        store.log(key, { role: 'sys', text: body.message });
        return json(res, 200, { ok: false, error: body.message, adapterError: body });
      } finally {
        store.state.busy--;
        store.broadcast('busy', { key, busy: false });
      }
    }

    // --- 데스크톱 앱 (ChatGPT) ---
    if (p === '/api/app/connect' && req.method === 'POST') {
      const { app } = await readBody(req);
      const r = await appBridge.relaunch(app);
      await refreshApps();
      return ok(res, r);
    }
    if (p === '/api/app/focus' && req.method === 'POST') {
      const { app } = await readBody(req);
      return ok(res, await appBridge.focus(app));
    }
    if (p === '/api/app/read' && req.method === 'POST') {
      const { app } = await readBody(req);
      return ok(res, await appBridge.run(app, 'read'));
    }
    if (p === '/api/app/send' && req.method === 'POST') {
      const { app, text, wait } = await readBody(req);
      const key = 'app:' + app;
      store.log(key, { role: 'user', text });
      store.broadcast('busy', { key, busy: true });
      try {
        const r = await appBridge.run(app, wait === false ? 'send' : 'sendAndWait', text);
        const reply = (r && r.reply) || '';
        if (reply) store.log(key, { role: 'assistant', text: reply });
        return ok(res, { reply });
      } finally {
        store.broadcast('busy', { key, busy: false });
      }
    }

    // --- 수동 카드 ---
    if (p === '/api/cards' && req.method === 'POST') {
      const body = await readBody(req);
      const card = {
        id: store.uid('card'), provider: 'other', title: '', note: '',
        status: 'idle', url: '', updatedAt: Date.now(), ...body,
      };
      store.state.cards.push(card);
      store.save(); store.pushState();
      return ok(res, card);
    }
    if (p === '/api/cards/update' && req.method === 'POST') {
      const body = await readBody(req);
      const c = store.state.cards.find((x) => x.id === body.id);
      if (!c) return fail(res, new Error('카드 없음'), 404);
      Object.assign(c, body, { updatedAt: Date.now() });
      store.save(); store.pushState();
      return ok(res, c);
    }
    if (p === '/api/cards/delete' && req.method === 'POST') {
      const { id } = await readBody(req);
      store.state.cards = store.state.cards.filter((c) => c.id !== id);
      store.save(); store.pushState();
      return ok(res);
    }

    // --- 워크플로우 ---
    if (p === '/api/wf/create' && req.method === 'POST') {
      const { name } = await readBody(req);
      return ok(res, wf.createWorkflow(name));
    }
    if (p === '/api/wf/update' && req.method === 'POST') {
      const { id, name } = await readBody(req);
      const w = wf.find(id);
      if (!w) return fail(res, new Error('작업 없음'), 404);
      if (typeof name === 'string') w.name = name;
      store.save(); store.pushState();
      return ok(res, w);
    }
    if (p === '/api/wf/delete' && req.method === 'POST') {
      const { id } = await readBody(req); wf.removeWorkflow(id); return ok(res);
    }
    if (p === '/api/wf/stage/add' && req.method === 'POST') {
      const b = await readBody(req); return ok(res, wf.addStage(b.wfId, b));
    }
    if (p === '/api/wf/stage/update' && req.method === 'POST') {
      const b = await readBody(req); return ok(res, wf.updateStage(b.wfId, b.stageId, b));
    }
    if (p === '/api/wf/stage/delete' && req.method === 'POST') {
      const b = await readBody(req); wf.removeStage(b.wfId, b.stageId); return ok(res);
    }
    if (p === '/api/wf/stage/run' && req.method === 'POST') {
      const b = await readBody(req);
      wf.runStage(b.wfId, b.stageId).catch(() => {});
      return ok(res);
    }
    if (p === '/api/wf/stage/complete' && req.method === 'POST') {
      const b = await readBody(req);
      return ok(res, wf.completeManual(b.wfId, b.stageId, b.output));
    }
    if (p === '/api/wf/start' && req.method === 'POST') {
      const b = await readBody(req);
      wf.start(b.id, b.fromStageId).catch(() => {});
      return ok(res);
    }
    if (p === '/api/wf/stop' && req.method === 'POST') {
      const b = await readBody(req); wf.stop(b.id); return ok(res);
    }

    if (p.startsWith('/api/')) return fail(res, new Error('없는 엔드포인트: ' + p), 404);
    return serveStatic(res, p);
  } catch (e) {
    return fail(res, e, 500);
  }
});

async function refreshCodex() {
  try {
    const a = adapters.get('codex-cli');
    if (!a) return;
    const list = await a.listThreads();
    const sig = (l) => JSON.stringify(l.map((x) => [x.id, x.updatedAt]));
    const changed = sig(list) !== sig(store.state.codex);
    store.state.codex = list;
    if (changed) store.pushState();
  } catch { /* codex 가 없거나 로그인 전 */ }
}

async function refreshAdapters() {
  try {
    const next = await adapters.describeAll();
    const sig = (l) => JSON.stringify(l.map((a) => [a.id, a.health.ok, a.health.reason || '']));
    const changed = sig(next) !== sig(store.state.adapters || []);
    store.state.adapters = next;
    if (changed) store.pushState();
  } catch { /* 어댑터 점검 실패는 화면만 비게 둔다 */ }
}

async function refreshApps() {
  try {
    const next = await appBridge.snapshot();
    const sig = (l) => JSON.stringify(l.map((a) => [a.id, a.connected, a.title]));
    const changed = sig(next) !== sig(store.state.apps);
    store.state.apps = next;
    if (changed) store.pushState();
  } catch { /* 앱이 없거나 응답 없음 */ }
}

// 예기치 못한 오류로 서버가 조용히 죽지 않게 한다.
// 어댑터들이 외부 프로세스와 네트워크를 다루므로 어딘가에서 거부된 프로미스가
// 새어 나올 수 있는데, Node 는 그걸 기본적으로 치명적 오류로 취급한다.
process.on('unhandledRejection', (e) => {
  console.error('[처리되지 않은 거부]', (e && e.stack) || e);
});
process.on('uncaughtException', (e) => {
  console.error('[처리되지 않은 예외]', (e && e.stack) || e);
});

store.load();
refreshClaude();
refreshApps();
setInterval(refreshApps, 5000);
refreshAdapters();
setInterval(refreshAdapters, 6000);
refreshCodex();
setInterval(refreshCodex, 10000);
setInterval(refreshClaude, 3000);
// 확장 온/오프라인 표시가 늦지 않도록 주기적으로 상태를 밀어준다
setInterval(() => store.pushState(), 5000);

// 서버 코드가 바뀌면 스스로 종료한다. start.cmd 의 루프가 3초 뒤 새 코드로 다시 띄운다.
// 사람이 재시작을 신경 쓰지 않아도 되도록 하기 위한 것이다.
function watchSources() {
  const dirs = [__dirname, path.join(__dirname, 'adapters'), path.join(__dirname, '..', 'channel')];
  let pendingRestart = false;

  // 처리 중인 요청이 있으면 끝날 때까지 기다렸다 재시작한다.
  // 안 그러면 사용자가 메시지를 보낸 순간 재시작이 걸려 답이 통째로 날아간다.
  function restartWhenIdle() {
    if (store.state.busy > 0) return setTimeout(restartWhenIdle, 1000);

    // 터미널은 이 프로세스의 자식이라 서버가 내려가면 같이 죽는다.
    // 쓰고 있는 터미널을 코드 저장 때문에 끊어 버리면 안 되므로 재시작을 미룬다.
    if (ptyHost.list().length) {
      console.log('[코드 변경] 터미널이 열려 있어 재시작을 미룹니다 (터미널을 닫으면 반영됩니다)');
      return setTimeout(restartWhenIdle, 5000);
    }
    console.log('[코드 변경] 다시 시작합니다');

    // 새 서버를 직접 띄우고 물러난다. 배치 파일이나 창이 필요 없다.
    // 셸을 거치지 않으므로 한글 경로에서도 깨지지 않는다.
    server.close();
    const child = spawn(process.execPath, [__filename], {
      cwd: path.join(__dirname, '..'),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    setTimeout(() => process.exit(0), 300);
  }

  for (const dir of dirs) {
    try {
      fs.watch(dir, (evt, name) => {
        if (pendingRestart || !name || !name.endsWith('.js')) return;
        pendingRestart = true;
        console.log('[코드 변경] ' + name + ' — 처리 중인 작업이 끝나면 다시 시작합니다');
        setTimeout(restartWhenIdle, 400);   // 저장이 끝날 시간을 준다
      });
    } catch { /* 폴더가 없으면 넘어간다 */ }
  }
}
watchSources();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT} 를 이미 쓰고 있습니다. 기존 FleetView 가 떠 있는지 확인하세요.`);
    process.exit(1);
  }
  console.error('[서버 오류]', e.message);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('FleetView  ->  http://localhost:' + PORT);
  console.log('Claude Code 세션 ' + store.state.claude.length + '개 감지됨');
});
