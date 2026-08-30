'use strict';
/**
 * Anthropic 공식 API 어댑터.
 *
 * 앱이나 브라우저를 조종하지 않고 Messages API 를 직접 호출한다.
 * 대화 이력은 이 어댑터가 직접 들고 있다 — 구독으로 쓰는 claude.ai / Claude 앱의
 * 대화 목록과는 별개다. API 는 과금도 구독과 별도다.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { AdapterError, register } = require('./contract');

const MODEL = process.env.FLEET_ANTHROPIC_MODEL || 'claude-opus-5';
const MAX_TOKENS = 16000;

// 이 어댑터가 소유하는 대화 이력. threadId -> { id, title, messages, updatedAt }
const threads = new Map();

let client = null;
function getClient() {
  if (client) return client;
  // SDK 가 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ant 프로필 순으로 알아서 찾는다.
  client = new Anthropic();
  return client;
}

const hasCredential = () =>
  !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** SDK 오류를 공통 규격으로 변환한다 */
function normalize(e) {
  const status = e && e.status;
  let code = 'internal';
  if (status === 401 || status === 403) code = 'auth';
  else if (status === 429) code = 'rate_limit';
  else if (status === 400 || status === 422) code = 'bad_request';
  else if (status === 404) code = 'not_found';
  else if (status >= 500) code = 'unavailable';
  else if (e && (e.name === 'APIConnectionTimeoutError' || e.code === 'ETIMEDOUT')) code = 'timeout';
  else if (e && e.name === 'APIConnectionError') code = 'unavailable';

  const msg = (e && (e.message || String(e))) || '알 수 없는 오류';
  return new AdapterError(code, msg, {
    provider: 'anthropic', adapterId: 'anthropic-api', status, cause: e,
  });
}

function thread(id) {
  if (id && threads.has(id)) return threads.get(id);
  const t = {
    id: id || 'th_' + Math.random().toString(36).slice(2, 10),
    title: '', messages: [], updatedAt: Date.now(),
  };
  threads.set(t.id, t);
  return t;
}

const adapter = {
  id: 'anthropic-api',
  provider: 'anthropic',
  label: 'Claude (API)',
  kind: 'api',
  agentType: 'chat',
  capabilities: { streaming: true, tools: true, history: true, threads: true },
  setupHint:
    'PowerShell 에서 키를 환경변수로 넣고 FleetView 를 다시 시작하세요:\n' +
    '  setx ANTHROPIC_API_KEY "여기에-키"\n' +
    '키는 console.anthropic.com 에서 발급합니다. API 사용료는 Claude 구독과 별도로 청구됩니다.',

  async health() {
    if (!hasCredential()) {
      return { ok: false, reason: 'ANTHROPIC_API_KEY 가 설정되지 않았습니다', code: 'auth' };
    }
    try {
      // 가장 싼 확인 방법. 모델 목록은 토큰을 쓰지 않는다.
      await getClient().models.retrieve(MODEL);
      return { ok: true, model: MODEL };
    } catch (e) {
      const n = normalize(e);
      return { ok: false, reason: n.message, code: n.code };
    }
  },

  async listThreads() {
    return [...threads.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({
        id: t.id,
        title: t.title || '(제목 없음)',
        updatedAt: t.updatedAt,
        meta: { turns: t.messages.length },
      }));
  },

  /**
   * @param {object}   p
   * @param {string=}  p.threadId  없으면 새 대화를 만든다
   * @param {string}   p.text
   * @param {function=} p.onDelta  스트리밍 조각마다 호출
   * @param {Array=}   p.tools     Messages API 도구 정의
   */
  async send({ threadId, text, onDelta, tools, signal } = {}) {
    if (!text || !String(text).trim()) {
      throw new AdapterError('bad_request', '보낼 내용이 비어 있습니다', {
        provider: 'anthropic', adapterId: adapter.id,
      });
    }
    if (!hasCredential()) {
      throw new AdapterError('auth', 'ANTHROPIC_API_KEY 가 설정되지 않았습니다', {
        provider: 'anthropic', adapterId: adapter.id,
      });
    }

    const t = thread(threadId);
    t.messages.push({ role: 'user', content: text });
    if (!t.title) t.title = String(text).replace(/\s+/g, ' ').slice(0, 60);

    try {
      const stream = getClient().messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        messages: t.messages,
        ...(tools && tools.length ? { tools } : {}),
      }, signal ? { signal } : undefined);

      if (onDelta) {
        stream.on('text', (chunk) => {
          try { onDelta(chunk); } catch { /* 소비자 쪽 오류는 삼킨다 */ }
        });
      }

      const message = await stream.finalMessage();

      // 다음 턴을 위해 응답 블록을 그대로 이력에 넣는다(thinking 블록 포함).
      t.messages.push({ role: 'assistant', content: message.content });
      t.updatedAt = Date.now();

      const outText = message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      const toolCalls = message.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));

      return {
        text: outText,
        threadId: t.id,
        stopReason: message.stop_reason,
        usage: message.usage,
        toolCalls,
      };
    } catch (e) {
      // 실패한 턴은 이력에서 되돌린다. 안 그러면 다음 요청이 깨진 상태로 나간다.
      t.messages.pop();
      throw normalize(e);
    }
  },
};

module.exports = register(adapter);
