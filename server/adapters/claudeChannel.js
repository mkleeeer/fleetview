'use strict';
/**
 * Claude Code 채널 어댑터.
 *
 * `claude -p --resume` 는 새 프로세스를 띄우므로, 대상 세션이 지금 열려 있으면
 * 대화 주인이 둘이 되어 기록이 갈라진다. 이 어댑터는 그 대신 이미 돌고 있는
 * 세션에 직접 메시지를 밀어넣는다. 주인이 하나라 갈라지지 않는다.
 *
 * 전제: 그 세션이 FleetView 채널을 붙인 채로 시작돼 있어야 한다.
 *   claude --dangerously-load-development-channels server:fleetview
 * 이미 떠 있는 세션에는 나중에 붙일 수 없다(세션당 최초 1회 재시작 필요).
 */
const { AdapterError, register } = require('./contract');
const hub = require('../channelHub');
const sessions = require('../claudeSessions');

function normalize(e) {
  const msg = (e && e.message) || String(e);
  const code = (e && e.code) || 'internal';
  return new AdapterError(code, msg, {
    provider: 'anthropic', adapterId: 'claude-channel', cause: e,
  });
}

const adapter = {
  id: 'claude-channel',
  provider: 'anthropic',
  label: 'Claude Code (채널)',
  kind: 'cli',
  agentType: 'coding',
  capabilities: { streaming: false, tools: true, history: true, threads: true, createThread: false },
  setupHint:
    '세션을 채널과 함께 시작해야 붙습니다:\n' +
    '  claude --dangerously-load-development-channels server:fleetview\n' +
    '기존 세션을 이어가려면 --resume <세션id> 를 함께 주세요.\n' +
    '이미 떠 있는 세션에는 나중에 붙일 수 없어 한 번 재시작해야 합니다.',

  async health() {
    const list = hub.live();
    return list.length
      ? { ok: true, channels: list.length }
      : { ok: false, reason: '채널이 붙은 세션이 없습니다', code: 'unavailable' };
  },

  async listThreads() {
    const known = sessions.scan();
    return hub.live().map((c) => {
      const s = known.find((x) => x.id === c.sessionId);
      return {
        id: c.sessionId,
        title: (s && s.title) || c.name || '(제목 없음)',
        updatedAt: (s && s.updatedAt) || 0,
        meta: { project: s && s.projectName, cwd: c.cwd, pid: c.pid, channel: true },
      };
    });
  },

  /** threadId 는 Claude Code 세션 id. 채널이 붙어 있어야 한다. */
  async send({ threadId, text } = {}) {
    if (!threadId) {
      throw new AdapterError('bad_request',
        '보낼 세션을 골라 주세요. 채널 어댑터는 새 세션을 만들지 않습니다.',
        { provider: 'anthropic', adapterId: adapter.id });
    }
    if (!hub.isConnected(threadId)) {
      throw new AdapterError('unavailable',
        '이 세션에는 채널이 붙어 있지 않습니다. 채널과 함께 다시 시작해 주세요.',
        { provider: 'anthropic', adapterId: adapter.id });
    }
    try {
      const r = await hub.send(threadId, text);
      return { text: r.text, threadId, usage: null, toolCalls: [] };
    } catch (e) {
      throw normalize(e);
    }
  },
};

module.exports = register(adapter);
