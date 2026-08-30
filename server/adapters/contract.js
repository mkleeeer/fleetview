'use strict';
/**
 * 어댑터 공통 규격.
 *
 * 대시보드와 워크플로우 엔진은 아래 인터페이스만 알면 되고,
 * 각 사업자의 차이(인증 방식, 이력 저장 위치, 스트리밍 프로토콜, 도구 호출 표현,
 * 오류 형식)는 어댑터가 흡수한다.
 *
 *   id            문자열 고유 키
 *   provider      'anthropic' | 'openai' | 'google'
 *   label         사람이 읽는 이름
 *   kind          'api'  공식 API — 안정적, 키 필요
 *                 'cli'  공식 CLI — 안정적, 구독 사용
 *                 'ui'   웹/앱 UI 자동화 — 구독 사용, DOM 의존이라 깨질 수 있음
 *   capabilities  { streaming, tools, history, threads }
 *
 *   async health()                     -> { ok, reason }
 *   async listThreads()                -> [{ id, title, updatedAt, meta }]
 *   async send({ threadId, text, onDelta, signal })
 *                                      -> { text, threadId, usage, toolCalls }
 *
 * send() 의 onDelta 는 스트리밍을 지원하는 어댑터만 호출한다.
 * 지원하지 않으면 완성된 결과만 돌려주고 onDelta 는 부르지 않는다.
 */

/** 모든 어댑터가 같은 형태로 실패하도록 정규화한 오류 */
class AdapterError extends Error {
  /**
   * @param {string} code  auth | rate_limit | unavailable | bad_request
   *                       | timeout | unsupported | not_found | internal
   */
  constructor(code, message, { provider, adapterId, retryable, status, cause } = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.provider = provider || null;
    this.adapterId = adapterId || null;
    this.status = status || null;
    this.retryable = retryable != null
      ? retryable
      : ['rate_limit', 'unavailable', 'timeout'].includes(code);
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      code: this.code, message: this.message, provider: this.provider,
      adapterId: this.adapterId, status: this.status, retryable: this.retryable,
    };
  }
}

/** 사람이 읽을 안내문. UI 가 이걸 그대로 보여준다. */
const HINTS = {
  auth: '인증이 필요합니다. 아래 설정 안내를 따라 주세요.',
  rate_limit: '요청이 몰렸습니다. 잠시 후 다시 시도하세요.',
  unavailable: '상대 서비스에 연결하지 못했습니다.',
  bad_request: '요청 형식이 잘못됐습니다.',
  timeout: '응답이 제한 시간을 넘겼습니다.',
  unsupported: '이 어댑터가 지원하지 않는 기능입니다.',
  not_found: '대상을 찾지 못했습니다.',
  internal: '처리 중 오류가 발생했습니다.',
};

const hintFor = (code) => HINTS[code] || HINTS.internal;

/** 어댑터 등록소 */
const registry = new Map();

function register(adapter) {
  for (const fn of ['health', 'send']) {
    if (typeof adapter[fn] !== 'function') {
      throw new Error(`어댑터 ${adapter.id} 에 ${fn}() 이 없습니다`);
    }
  }
  registry.set(adapter.id, adapter);
  return adapter;
}

const get = (id) => registry.get(id) || null;
const all = () => [...registry.values()];

function must(id) {
  const a = get(id);
  if (!a) throw new AdapterError('not_found', `어댑터를 찾을 수 없습니다: ${id}`, { adapterId: id });
  return a;
}

/** 대시보드로 내보낼 어댑터 요약 (health 는 각자 캐시해서 빠르게 답한다) */
async function describeAll() {
  return Promise.all(all().map(async (a) => {
    let health;
    try { health = await a.health(); }
    catch (e) { health = { ok: false, reason: e.message }; }
    return {
      id: a.id, provider: a.provider, label: a.label, kind: a.kind,
      capabilities: a.capabilities || {},
      setupHint: a.setupHint || '',
      health,
    };
  }));
}

module.exports = { AdapterError, hintFor, register, get, all, must, describeAll, registry };
