'use strict';
/**
 * 채널 허브 — 실행 중인 Claude Code 세션과의 양방향 통로.
 *
 * 대시보드 → (큐) → 채널이 롱폴링으로 가져감 → 세션에 주입
 * 세션 → Claude 가 fleetview_reply 호출 → 여기서 대기 중이던 요청을 깨움
 *
 * 크롬 확장용 bridge.js 와 구조가 같다. 다만 세션이 여럿이라 세션별로 큐를 둔다.
 */
const store = require('./store');
const sessions = require('./claudeSessions');

const REPLY_TIMEOUT = 600000;   // 클로드는 오래 걸리는 작업을 할 수 있다
const HOLD_MS = 25000;          // 롱폴링 유지 시간

// sessionId -> { sessionId, name, cwd, pid, lastSeen }
const channels = new Map();
// sessionId -> [ {id, text} ]
const queues = new Map();
// sessionId -> res (롱폴링 중인 응답 객체)
const waiters = new Map();
// msgId -> { resolve, reject, timer }
const pending = new Map();

const queueOf = (sid) => queues.get(sid) || (queues.set(sid, []), queues.get(sid));

function register({ sessionId, name, cwd, pid }) {
  if (!sessionId) return null;
  const c = { sessionId, name: name || '', cwd: cwd || '', pid: pid || 0, lastSeen: Date.now() };
  channels.set(sessionId, c);
  store.pushState();
  return c;
}

function flush(sid) {
  const res = waiters.get(sid);
  const q = queueOf(sid);
  if (!res || !q.length) return;
  waiters.delete(sid);
  clearTimeout(res._fvTimer);
  const batch = q.splice(0, q.length);
  try { res.end(JSON.stringify({ messages: batch })); } catch {}
}

/** 채널의 롱폴링 요청을 붙잡아 둔다 */
function hold(sid, res) {
  if (!sid) { try { res.end(JSON.stringify({ messages: [] })); } catch {} return; }

  const c = channels.get(sid);
  if (c) c.lastSeen = Date.now();
  else register({ sessionId: sid });   // 서버가 재시작했으면 다시 받아준다

  const old = waiters.get(sid);
  if (old) { try { old.end(JSON.stringify({ messages: [] })); } catch {} }

  waiters.set(sid, res);
  res._fvTimer = setTimeout(() => {
    if (waiters.get(sid) === res) {
      waiters.delete(sid);
      try { res.end(JSON.stringify({ messages: [] })); } catch {}
    }
  }, HOLD_MS);
  res.on('close', () => { if (waiters.get(sid) === res) waiters.delete(sid); });

  flush(sid);
}

/**
 * 대시보드 → 세션. 답이 돌아올 때까지 기다린다.
 *
 * 답을 받는 길이 둘이다.
 *   1) Claude 가 fleetview_reply 도구를 부른다 — 가장 정확하다
 *   2) 안 부르면 세션 기록 파일에서 새로 생긴 응답을 주워 온다
 *
 * 2번이 필요한 이유: 지시문에 "반드시 도구를 부르라" 고 써도 강제할 수 없다.
 * 짧은 대화일수록 그냥 화면에만 답하고 끝내는데, 그러면 대시보드가 영영 기다린다.
 */
function send(sessionId, text) {
  if (!channels.has(sessionId)) {
    const e = new Error('이 세션에는 FleetView 채널이 붙어 있지 않습니다');
    e.code = 'unavailable';
    return Promise.reject(e);
  }

  const id = store.uid('msg');
  queueOf(sessionId).push({ id, text });
  flush(sessionId);

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      pending.delete(id);
      fn(arg);
    };

    // 1) 도구 호출을 기다린다
    pending.set(id, {
      resolve: (v) => finish(resolve, v),
      reject: (e) => finish(reject, e),
      timer: null,
    });

    // 2) 기록 파일도 함께 살핀다. 도구를 안 불러도 답을 건진다.
    //
    // "마지막 어시스턴트 발화" 를 줍지 않는다. 그러면 사용자가 그 창에서 동시에
    // 다른 걸 물어봤을 때 그 답을 가로챈다. 대신 우리가 넣은 메시지의 msg_id 를
    // 기록에서 찾아, 그 뒤부터 다음 사용자 발화 전까지만 모은다.
    let stable = 0;
    let seen = '';
    const watch = setInterval(() => {
      const r = sessions.replyTo(sessionId, id);
      if (!r.found || !r.text) return;

      // 턴이 끝난 표시가 있으면 기다리지 않고 바로 확정한다.
      // closed: 다음 사용자 발화가 나타남 / ended: 답 뒤에 system 항목이 찍힘
      if (r.closed || r.ended) {
        return finish(resolve, { text: r.text, sessionId, via: 'transcript' });
      }

      // 표시가 아직 없으면 변화가 멎을 때까지만 기다린다.
      if (r.text === seen) {
        stable++;
        if (stable >= 3) finish(resolve, { text: r.text, sessionId, via: 'transcript' });
      } else {
        seen = r.text;
        stable = 0;
      }
    }, 700);

    const timer = setTimeout(() => {
      const e = new Error('세션이 제한 시간 안에 답하지 않았습니다');
      e.code = 'timeout';
      finish(reject, e);
    }, REPLY_TIMEOUT);
  });
}

/** 세션 → 대시보드 */
function reply({ sessionId, msgId, text }) {
  const p = pending.get(msgId);
  if (!p) return false;
  p.resolve({ text: text || '', sessionId, via: 'tool' });
  return true;
}

/** 최근에 폴링한 채널만 살아있는 것으로 본다 */
function live() {
  const now = Date.now();
  const out = [];
  for (const c of channels.values()) {
    if (now - c.lastSeen < 90000) out.push(c);
    else channels.delete(c.sessionId);
  }
  return out;
}

const isConnected = (sid) => live().some((c) => c.sessionId === sid);

module.exports = { register, hold, send, reply, live, isConnected };
