'use strict';
/**
 * 가짜 터미널로 Claude Code 를 띄운다.
 *
 * 지금까지는 cmd 창을 하나 띄우고 그 안에서 claude 를 실행했다. 창이 화면에 뜨고,
 * 사용자가 그 창을 관리해야 했다.
 *
 * 여기서는 창을 만들지 않는다. node-pty 로 가짜 터미널을 만들어 그 안에서 실행하고,
 * 화면 내용은 대시보드가 받아서 그린다. CLI 는 자기가 터미널에 있는 줄 알고 평소대로
 * 동작한다. Orca 같은 AI IDE 가 쓰는 방식과 같다.
 *
 * 덕분에 시작 화면(개발 채널 경고 등)도 대시보드에서 답할 수 있다.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const store = require('./store');

let pty = null;
try { pty = require('node-pty'); } catch { /* 없으면 이 기능만 비활성 */ }

const BUFFER_BYTES = 200 * 1024;   // 다시 접속했을 때 되돌려 줄 최근 화면
const sessions = new Map();        // ptyId -> { id, proc, cwd, buf, cols, rows, startedAt }

const available = () => !!pty;

/** 새 세션에 물려주면 안 되는 표시들 (sessionLauncher 와 같은 이유) */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
                   'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE']) delete env[k];
  return env;
}

function append(s, data) {
  s.buf += data;
  if (s.buf.length > BUFFER_BYTES) s.buf = s.buf.slice(-BUFFER_BYTES);
}

/**
 * @param {string}  cwd       작업 폴더
 * @param {string=} resumeId  이어갈 세션 id
 * @param {boolean} channel   FleetView 채널을 붙일지
 */
function create({ cwd, resumeId, channel = true, cols = 120, rows = 32 } = {}) {
  if (!pty) throw new Error('node-pty 를 불러오지 못했습니다');
  if (!cwd || !fs.existsSync(cwd)) throw new Error('폴더를 찾을 수 없습니다: ' + cwd);

  const args = [];
  if (resumeId) args.push('--resume', resumeId);
  if (channel) args.push('--dangerously-load-development-channels', 'server:fleetview');

  const proc = pty.spawn('claude.cmd', args, {
    name: 'xterm-256color', cols, rows, cwd, env: cleanEnv(),
  });

  const id = store.uid('pty');
  const s = { id, proc, cwd, resumeId: resumeId || null, buf: '', cols, rows, startedAt: Date.now(), autoAnswered: false };
  sessions.set(id, s);

  proc.onData((data) => {
    append(s, data);

    // 개발 채널 경고를 자동으로 넘긴다.
    //
    // 판단 기준을 "경고가 보이면 누른다" 로 잡으면 안 된다. TUI 가 화면을 계속 다시
    // 그려서 그 문구가 최근 버퍼에서 밀려나면 재시도를 영영 멈춘다.
    // 대신 "클로드 배너가 뜰 때까지 누른다" 로 잡는다.
    if (!s.autoAnswered && /I am using this for local development/.test(s.buf)) {
      s.autoAnswered = true;
      let tries = 0;
      const press = () => {
        if (tries++ > 8) return;
        if (/Claude Code v/.test(s.buf)) return;   // 넘어갔다
        try { proc.write(String.fromCharCode(13)); } catch {}
        setTimeout(press, 1500);
      };
      setTimeout(press, 1500);
    }

    store.broadcast('pty', { id, data });
  });

  proc.onExit((e) => {
    store.broadcast('pty-exit', { id, code: e.exitCode });
    sessions.delete(id);
  });

  store.pushState();
  return { id, cwd, resumeId: s.resumeId };
}

function write(id, data) {
  const s = sessions.get(id);
  if (!s) throw new Error('그 터미널이 없습니다');
  s.proc.write(data);
}

function resize(id, cols, rows) {
  const s = sessions.get(id);
  if (!s) return;
  s.cols = cols; s.rows = rows;
  try { s.proc.resize(cols, rows); } catch {}
}

function kill(id) {
  const s = sessions.get(id);
  if (!s) return false;
  try { s.proc.kill(); } catch {}
  sessions.delete(id);
  store.pushState();
  return true;
}

/** 다시 접속했을 때 화면을 복원하기 위한 최근 출력 */
const buffer = (id) => {
  const s = sessions.get(id);
  return s ? s.buf : '';
};

const list = () => [...sessions.values()].map((s) => ({
  id: s.id, cwd: s.cwd, resumeId: s.resumeId,
  cols: s.cols, rows: s.rows, startedAt: s.startedAt,
}));

module.exports = { available, create, write, resize, kill, buffer, list };
