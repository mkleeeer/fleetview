'use strict';
/**
 * Claude Code CLI 어댑터.
 *
 * 공식 CLI 를 헤드리스로 호출한다. UI 자동화가 아니라서 앱 정책과 무관하고,
 * Claude 구독을 그대로 쓴다(API 별도 과금 없음).
 * 대화 이력은 CLI 가 ~/.claude/projects 에 들고 있으므로 여기서는 읽기만 한다.
 */
const { AdapterError, register } = require('./contract');
const runner = require('../claudeRunner');
const sessions = require('../claudeSessions');

function normalize(e) {
  const msg = (e && e.message) || String(e);
  let code = 'internal';
  if (/이미 실행 중/.test(msg)) code = 'bad_request';
  else if (/실행 실패|ENOENT|not recognized/i.test(msg)) code = 'unavailable';
  else if (/종료 코드/.test(msg)) code = 'internal';
  return new AdapterError(code, msg, {
    provider: 'anthropic', adapterId: 'claude-code', cause: e,
  });
}

const adapter = {
  id: 'claude-code',
  provider: 'anthropic',
  label: 'Claude Code (CLI)',
  kind: 'cli',
  capabilities: { streaming: true, tools: true, history: true, threads: true, createThread: true },
  setupHint: 'claude CLI 가 PATH 에 있어야 합니다. 이미 설치되어 있으면 따로 할 일이 없습니다.',

  async health() {
    const list = sessions.scan();
    return { ok: true, sessions: list.length };
  },

  async listThreads() {
    return sessions.scan().map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      meta: { project: s.projectName, status: s.status, lastTool: s.lastTool },
    }));
  },

  /**
   * threadId 가 있으면 그 Claude Code 세션을 이어가고,
   * 없으면 cwd 에서 새 세션을 시작한다. 둘 다 구독으로 돌아간다(API 과금 없음).
   *
   * @param {string=} threadId  이어갈 세션 id
   * @param {string=} cwd       새 세션을 시작할 폴더 (없으면 서버 작업 폴더)
   */
  async send({ threadId, text, cwd, onDelta } = {}) {
    const known = threadId && sessions.scan().find((s) => s.id === threadId);
    if (threadId && !known) {
      throw new AdapterError('not_found', `Claude Code 세션을 찾을 수 없습니다: ${threadId}`,
        { provider: 'anthropic', adapterId: adapter.id });
    }
    const workdir = (known && known.project) || cwd || process.cwd();

    try {
      const before = threadId ? null : new Set(sessions.scan().map((s) => s.id));
      const out = await runner.send(threadId || null, text, { cwd: workdir, onChunk: onDelta });

      // 새 세션이었으면 방금 생긴 세션 id 를 찾아 돌려준다. 다음 단계가 이어갈 수 있도록.
      let id = threadId;
      if (!id) {
        const fresh = sessions.scan().filter((s) => !before.has(s.id));
        fresh.sort((a, b) => b.updatedAt - a.updatedAt);
        id = fresh.length ? fresh[0].id : null;
      }
      return { text: out, threadId: id, usage: null, toolCalls: [] };
    } catch (e) {
      throw normalize(e);
    }
  },
};

module.exports = register(adapter);
