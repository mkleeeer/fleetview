'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const store = require('./store');
const bridge = require('./bridge');
const runner = require('./claudeRunner');
const wf = require('./workflow');
const claudeSessions = require('./claudeSessions');
const appBridge = require('./appBridge');
const adapters = require('./adapters');
const channelHub = require('./channelHub');

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
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

// ---- Claude Code 세션 폴링 ------------------------------------------------
function refreshClaude() {
  const next = claudeSessions.scan();
  const sig = (list) => JSON.stringify(list.map((s) => [s.id, s.status, s.updatedAt]));
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
      const { id, threadId, text, stream, cwd } = await readBody(req);
      const a = adapters.must(id);
      const key = 'ad:' + id + ':' + (threadId || 'new');
      store.log(key, { role: 'user', text });
      store.broadcast('busy', { key, busy: true });
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

store.load();
refreshClaude();
refreshApps();
setInterval(refreshApps, 5000);
refreshAdapters();
setInterval(refreshAdapters, 6000);
setInterval(refreshClaude, 3000);
// 확장 온/오프라인 표시가 늦지 않도록 주기적으로 상태를 밀어준다
setInterval(() => store.pushState(), 5000);

server.listen(PORT, '127.0.0.1', () => {
  console.log('FleetView  ->  http://localhost:' + PORT);
  console.log('Claude Code 세션 ' + store.state.claude.length + '개 감지됨');
});
