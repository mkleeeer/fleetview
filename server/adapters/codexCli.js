'use strict';
/**
 * Codex CLI 어댑터 (OpenAI).
 *
 * ChatGPT 를 화면 조종이 아니라 공식 CLI 로 붙인다.
 * ChatGPT 구독 로그인을 그대로 쓰므로 API 키도, 별도 과금도 없다.
 *
 * 세션 목록은 ~/.codex/session_index.jsonl 에서 읽는다.
 * 전송은 codex exec (새 세션) / codex exec resume (기존 세션 이어가기).
 *
 * 주의: 프롬프트는 반드시 stdin 으로 넘긴다. argv 로 넘기면 윈도우에서
 *      셸을 거치며 공백에서 잘린다(claudeRunner 와 같은 함정).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { AdapterError, register } = require('./contract');

const CODEX_HOME = path.join(os.homedir(), '.codex');
const INDEX = path.join(CODEX_HOME, 'session_index.jsonl');
const TIMEOUT_MS = 300000;

function normalize(e) {
  const msg = (e && e.message) || String(e);
  let code = 'internal';
  if (/Not inside a trusted directory/i.test(msg)) code = 'bad_request';
  else if (/not logged in|login/i.test(msg)) code = 'auth';
  else if (/ENOENT|not recognized|실행 실패/i.test(msg)) code = 'unavailable';
  else if (/시간 초과|timed out/i.test(msg)) code = 'timeout';
  else if (/No session|not found/i.test(msg)) code = 'not_found';
  return new AdapterError(code, msg, { provider: 'openai', adapterId: 'codex-cli', cause: e });
}

/** codex 를 돌리고 최종 답변만 받아온다 */
function run(args, { cwd, text, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    // -o 로 마지막 메시지만 파일에 받는다. JSONL 이벤트를 파싱하는 것보다 안전하다.
    const outFile = path.join(os.tmpdir(),
      'fleetview-codex-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.txt');

    const child = spawn('codex', [...args, '--skip-git-repo-check', '-o', outFile], {
      cwd: cwd || process.cwd(),
      shell: true,            // 윈도우의 codex.cmd 를 타기 위해 필요
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    });

    let log = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('codex 응답 시간 초과'));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      const s = d.toString();
      log += s;
      if (onChunk) onChunk(s);
    });
    child.stderr.on('data', (d) => { err += d.toString(); });

    child.stdin.on('error', () => {});
    if (text != null) { child.stdin.write(text); }
    child.stdin.end();

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('codex 실행 실패: ' + e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let answer = '';
      try { answer = fs.readFileSync(outFile, 'utf8').trim(); } catch {}
      try { fs.unlinkSync(outFile); } catch {}

      if (code !== 0 && !answer) {
        return reject(new Error((err || log).trim().split('\n').slice(-3).join(' ') || `codex 종료 코드 ${code}`));
      }
      // 실행 로그에서 세션 id 를 뽑아 둔다. 새 세션이면 이걸로 이어갈 수 있다.
      const m = log.match(/session id:\s*([0-9a-f-]{36})/i);
      resolve({ text: answer, sessionId: m ? m[1] : null });
    });
  });
}

function readIndex() {
  let raw;
  try { raw = fs.readFileSync(INDEX, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const j = JSON.parse(s);
      if (j.id) out.push(j);
    } catch { /* 잘린 줄 무시 */ }
  }
  // 같은 id 가 여러 번 나오면 마지막 것만 남긴다
  const byId = new Map();
  for (const j of out) byId.set(j.id, j);
  return [...byId.values()];
}

const adapter = {
  id: 'codex-cli',
  provider: 'openai',
  label: 'Codex (CLI)',
  kind: 'cli',
  agentType: 'coding',
  capabilities: { streaming: true, tools: true, history: true, threads: true, createThread: true },
  setupHint: 'codex CLI 가 PATH 에 있어야 합니다. `codex login` 으로 ChatGPT 계정에 로그인하세요.',

  async health() {
    return new Promise((resolve) => {
      execFile('codex', ['login', 'status'], { shell: true, windowsHide: true, timeout: 15000 },
        (e, stdout, stderr) => {
          const s = ((stdout || '') + (stderr || '')).trim();
          if (e && !/Logged in/i.test(s)) {
            return resolve({ ok: false, reason: s || 'codex 를 실행하지 못했습니다', code: 'unavailable' });
          }
          if (/Logged in/i.test(s)) {
            return resolve({ ok: true, account: s.replace(/\s+/g, ' ').slice(0, 60), sessions: readIndex().length });
          }
          resolve({ ok: false, reason: s || '로그인되어 있지 않습니다', code: 'auth' });
        });
    });
  },

  async listThreads() {
    return readIndex()
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .map((j) => ({
        id: j.id,
        title: j.thread_name || '(제목 없음)',
        updatedAt: Date.parse(j.updated_at || '') || 0,
        meta: {},
      }));
  },

  /**
   * threadId 가 있으면 그 Codex 세션을 이어가고, 없으면 새로 시작한다.
   * 둘 다 ChatGPT 구독으로 동작한다.
   */
  async send({ threadId, text, cwd, onDelta } = {}) {
    if (!text || !String(text).trim()) {
      throw new AdapterError('bad_request', '보낼 내용이 비어 있습니다',
        { provider: 'openai', adapterId: adapter.id });
    }
    try {
      const args = threadId ? ['exec', 'resume', threadId, '-'] : ['exec', '-'];
      const r = await run(args, { cwd, text, onChunk: onDelta });
      return {
        text: r.text || '(응답이 비어 있습니다)',
        threadId: threadId || r.sessionId,
        usage: null,
        toolCalls: [],
      };
    } catch (e) {
      throw normalize(e);
    }
  },
};

module.exports = register(adapter);
