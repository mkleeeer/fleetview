'use strict';
/**
 * 크롬 확장과의 다리.
 * 확장이 /api/ext/poll 을 롱폴링하고, 서버는 여기 쌓인 명령을 응답으로 흘려보낸다.
 * 명령 결과는 확장이 /api/ext/result 로 돌려주고, 대기 중인 Promise 를 깨운다.
 */
const store = require('./store');

const queue = [];       // 확장에게 보낼 명령
const pending = new Map(); // cmdId -> {resolve, reject, timer}
let waiter = null;      // 롱폴링 중인 res

const DEFAULT_TIMEOUT = 180000;

function flush() {
  if (!waiter || queue.length === 0) return;
  const res = waiter;
  waiter = null;
  clearTimeout(res._fvTimer);
  const batch = queue.splice(0, queue.length);
  try { res.end(JSON.stringify({ commands: batch })); } catch {}
}

/** 확장의 롱폴링 요청을 붙잡아 둔다 */
function hold(res) {
  if (waiter) { try { waiter.end(JSON.stringify({ commands: [] })); } catch {} }
  waiter = res;
  res._fvTimer = setTimeout(() => {
    if (waiter === res) { waiter = null; try { res.end(JSON.stringify({ commands: [] })); } catch {} }
  }, 25000);
  res.on('close', () => { if (waiter === res) waiter = null; });
  flush();
}

/** 확장에 명령을 보내고 결과를 기다린다 */
function send(action, payload, timeout = DEFAULT_TIMEOUT) {
  const id = store.uid('cmd');
  queue.push({ id, action, payload });
  flush();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('확장 응답 시간 초과 (' + action + ')'));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
  });
}

/** 응답이 필요 없는 단방향 명령 */
function push(action, payload) {
  queue.push({ id: store.uid('cmd'), action, payload: payload || {} });
  flush();
}

/** 확장이 결과를 돌려줬을 때 */
function resolveResult({ id, ok, data, error }) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  if (ok) p.resolve(data);
  else p.reject(new Error(error || '확장에서 실패'));
  return true;
}

const isOnline = () => Date.now() - store.state.extLastSeen < 45000;

module.exports = { hold, push, send, resolveResult, isOnline };
