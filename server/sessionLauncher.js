'use strict';
/**
 * 세션 시작 — 대시보드에서 Claude Code 세션을 채널과 함께 띄운다.
 *
 * 이렇게 띄운 세션은 처음부터 채널이 붙어 있어서, 대시보드에서 보낸 메시지가
 * 실행 중인 그 창으로 바로 들어간다. 곁가지가 생기지 않는다.
 *
 * 주의 — 환경변수를 반드시 비워야 한다:
 *   FleetView 서버가 다른 Claude Code 세션 안에서 시작됐다면 CLAUDE_CODE_CHILD_SESSION
 *   같은 표시가 환경에 남아 있다. 그대로 물려주면 새 세션이 "자식 세션"으로 인식되어
 *   트랜스크립트가 저장되지 않고, 그러면 ~/.claude/sessions/<pid>.json 도 안 생겨서
 *   채널이 자기 세션을 찾지 못한다.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hub = require('./channelHub');
const sessions = require('./claudeSessions');

// 새 세션에 물려주면 안 되는 표시들
const INHERITED_MARKERS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
];

function cleanEnv() {
  const env = { ...process.env };
  for (const k of INHERITED_MARKERS) delete env[k];
  return env;
}

/** 대시보드에서 고를 수 있는 폴더 목록 — 기존 세션들이 쓰던 곳 */
function knownFolders() {
  const seen = new Map();
  for (const s of sessions.scan()) {
    if (!s.project || seen.has(s.project)) continue;
    if (!fs.existsSync(s.project)) continue;
    seen.set(s.project, { path: s.project, name: s.projectName, lastUsed: s.updatedAt });
  }
  return [...seen.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

/**
 * @param {string}  cwd       세션을 시작할 폴더
 * @param {string=} resumeId  이어갈 세션 id (없으면 새 세션)
 * @returns {Promise<{sessionId, cwd, resumed}>}
 */
async function launch({ cwd, resumeId } = {}) {
  if (!cwd || !fs.existsSync(cwd)) {
    const e = new Error('폴더를 찾을 수 없습니다: ' + (cwd || '(비어 있음)'));
    e.code = 'bad_request';
    throw e;
  }
  if (resumeId && hub.isConnected(resumeId)) {
    const e = new Error('그 세션은 이미 채널로 연결되어 있습니다');
    e.code = 'bad_request';
    throw e;
  }

  const before = new Set(hub.live().map((c) => c.sessionId));

  const parts = ['claude'];
  if (resumeId) parts.push('--resume', resumeId);
  parts.push('--dangerously-load-development-channels', 'server:fleetview');

  // 명령을 start 의 인자로 넘기면 공백과 && 가 깨진다. 배치 파일로 빼서 그 문제를 없앤다.
  const script = path.join(os.tmpdir(),
    'fleetview-launch-' + Date.now() + Math.random().toString(36).slice(2, 6) + '.cmd');
  const CRLF = String.fromCharCode(13, 10);   // 이스케이프를 쓰지 않는다
  fs.writeFileSync(script, [
    '@echo off',
    'chcp 65001 >nul',
    `title FleetView - ${resumeId ? resumeId.slice(0, 8) : 'new'}`,
    `cd /d "${cwd.replace(/\//g, String.fromCharCode(92))}"`,
    parts.join(' '),
    '',
  ].join(CRLF), 'utf8');

  // start 로 별도 콘솔 창을 띄운다. 사용자가 그 창에서 직접 이어서 작업할 수 있다.
  // start 에 배치 파일만 넘긴다. /D 나 중첩 cmd /k 를 붙이면 창이 안 뜬다.
  const child = spawn('cmd.exe', ['/c', 'start', '""', script], {
    env: cleanEnv(),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  setTimeout(() => { try { fs.unlinkSync(script); } catch {} }, 120000);

  // 채널이 붙을 때까지 기다린다. 시작 화면에서 사람이 뭘 눌러야 할 수도 있어 넉넉히 준다.
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const live = hub.live();
    if (resumeId) {
      if (live.some((c) => c.sessionId === resumeId)) {
        return { sessionId: resumeId, cwd, resumed: true };
      }
    } else {
      const fresh = live.find((c) => !before.has(c.sessionId));
      if (fresh) return { sessionId: fresh.sessionId, cwd, resumed: false };
    }
  }

  const e = new Error(
    '창은 띄웠지만 채널이 붙지 않았습니다. 그 창에 시작 화면이 떠 있는지 확인해 주세요.');
  e.code = 'timeout';
  throw e;
}

module.exports = { launch, knownFolders, cleanEnv };
