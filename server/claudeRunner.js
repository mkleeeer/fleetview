'use strict';
/**
 * claude CLI 를 헤드리스로 불러 특정 세션에 메시지를 넣고 답을 받아온다.
 * 주의: 같은 세션을 터미널에서 열어둔 채로 쓰면 트랜스크립트가 꼬일 수 있다.
 *      UI 에서 그 점을 경고한다.
 */
const { spawn } = require('child_process');
const store = require('./store');

const running = new Map(); // sessionId -> child

function isBusy(sessionId) { return running.has(sessionId); }

/**
 * @param {string|null} sessionId  이어갈 세션 id. null 이면 새 세션을 시작한다.
 *                                 새 세션도 구독으로 돌아간다(API 과금 없음).
 */
function send(sessionId, text, { cwd, onChunk } = {}) {
  const key = sessionId || 'new:' + (cwd || '.');
  if (running.has(key)) {
    return Promise.reject(new Error('이 세션은 이미 실행 중입니다'));
  }
  return new Promise((resolve, reject) => {
    // 프롬프트를 argv 로 넘기면 안 된다. 윈도우에서 셸을 거치며 공백에서 잘려
    // 첫 단어만 전달된다. stdin 으로 넘기면 그대로 간다.
    const args = sessionId ? ['-p', '--resume', sessionId] : ['-p'];
    const child = spawn('claude', args, {
      cwd: cwd || process.cwd(),
      shell: true,           // 윈도우의 claude.cmd 를 타기 위해 필요
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    running.set(key, child);

    child.stdin.on('error', () => {});   // 자식이 먼저 죽으면 EPIPE 가 난다
    child.stdin.write(text);
    child.stdin.end();

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (onChunk) onChunk(s);
    });
    child.stderr.on('data', (d) => { err += d.toString(); });

    child.on('error', (e) => {
      running.delete(key);
      reject(new Error('claude 실행 실패: ' + e.message));
    });
    child.on('close', (code) => {
      running.delete(key);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `claude 종료 코드 ${code}`));
    });
  });
}

function cancel(sessionId) {
  const c = running.get(sessionId);
  if (!c) return false;
  c.kill();
  running.delete(sessionId);
  return true;
}

module.exports = { send, cancel, isBusy, running };
