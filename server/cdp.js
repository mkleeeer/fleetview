'use strict';
/**
 * 최소한의 Chrome DevTools Protocol 클라이언트.
 * Node 22+ 의 내장 WebSocket 만 쓴다 (의존성 없음).
 */

function connect(wsUrl, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const waiting = new Map();

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('CDP 연결 시간 초과'));
    }, timeout);

    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const w = m.id && waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP 연결 실패'));
    });
    ws.addEventListener('close', () => {
      for (const w of waiting.values()) w({ error: { message: '연결이 끊어졌습니다' } });
      waiting.clear();
    });
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params, ms = 200000) {
          return new Promise((res, rej) => {
            const id = ++seq;
            const t = setTimeout(() => { waiting.delete(id); rej(new Error(method + ' 시간 초과')); }, ms);
            waiting.set(id, (m) => {
              clearTimeout(t);
              if (m.error) rej(new Error(m.error.message));
              else res(m.result);
            });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close: () => { try { ws.close(); } catch {} },
      });
    });
  });
}

/** 해당 타깃에서 표현식을 평가하고 값을 돌려준다 */
async function evaluate(wsUrl, expression, { awaitPromise = true, ms = 200000 } = {}) {
  const c = await connect(wsUrl);
  try {
    const r = await c.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }, ms);
    if (r.exceptionDetails) {
      const e = r.exceptionDetails;
      throw new Error(
        (e.exception && (e.exception.description || e.exception.value)) || e.text || '페이지 실행 오류');
    }
    return r.result ? r.result.value : undefined;
  } finally {
    c.close();
  }
}

/** 앱 창을 앞으로 가져온다 */
async function bringToFront(wsUrl) {
  const c = await connect(wsUrl);
  try { await c.send('Page.bringToFront', {}, 5000); }
  finally { c.close(); }
}

/** 디버그 포트에서 타깃 목록을 가져온다 */
async function targets(port) {
  const r = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(3000) });
  return r.json();
}

async function isUp(port) {
  try {
    await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) });
    return true;
  } catch { return false; }
}

module.exports = { connect, evaluate, bringToFront, targets, isUp };
