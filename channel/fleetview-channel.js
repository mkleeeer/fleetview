#!/usr/bin/env node
'use strict';
/**
 * FleetView 채널 — 실행 중인 Claude Code 세션에 메시지를 직접 밀어넣는 MCP 서버.
 *
 * 왜 필요한가:
 *   `claude -p --resume <id>` 는 새 프로세스를 띄운다. 그 세션이 지금 터미널에
 *   열려 있으면 두 프로세스가 각자 대화를 소유하게 되어 기록이 갈라진다.
 *   채널은 이미 돌고 있는 그 세션에 직접 이벤트를 넣으므로 갈라지지 않는다.
 *
 * 어떻게 도는가:
 *   Claude Code 가 이 파일을 자식 프로세스로 띄운다(stdio MCP).
 *   1) 부모 프로세스를 거슬러 올라가 자기가 어느 세션에 속하는지 알아낸다
 *   2) FleetView 서버에 등록하고 롱폴링으로 보낼 메시지를 받아온다
 *   3) notifications/claude/channel 로 세션에 밀어넣는다
 *   4) 답은 세션 기록에서 읽어 온다 (도구를 부르게 하지 않는다 — 턴이 하나 더 들기 때문)
 *
 * 실행:
 *   claude --dangerously-load-development-channels server:fleetview
 *   (리서치 프리뷰라 커스텀 채널은 개발 플래그가 필요하다)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const SERVER = process.env.FLEET_URL || 'http://127.0.0.1:7777';
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

// ---------- 내가 어느 세션에 속하는지 알아내기 --------------------------------
/**
 * Claude Code 는 실행 중인 세션마다 ~/.claude/sessions/<pid>.json 을 남긴다.
 * 이 프로세스의 부모(또는 그 위)가 그 pid 다. 중간에 셸이 끼는 경우가 있어
 * 몇 단계 거슬러 올라가며 찾는다.
 */
function findSession() {
  const read = (pid) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, pid + '.json'), 'utf8'));
    } catch { return null; }
  };
  const parentOf = (pid) => {
    try {
      const out = execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
         `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
        { windowsHide: true, timeout: 8000 }).toString().trim();
      const n = Number(out);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
  };

  let pid = process.ppid;
  for (let i = 0; i < 6 && pid; i++) {
    const j = read(pid);
    if (j && j.sessionId) return { ...j, hostPid: pid };
    pid = parentOf(pid);
  }
  return null;
}

/**
 * 이 세션이 진짜 "채널로" 나를 띄웠는지 확인한다.
 *
 * MCP 서버를 user 스코프로 등록하면 모든 세션에서 자동 로드된다. 그러면 --channels
 * 없이 시작한 세션에서도 이 파일이 뜬다. 그런 세션은 notifications/claude/channel 을
 * 받아주지 않으므로, 등록해봐야 대시보드에 "붙었다"고 거짓말하는 꼴이 된다.
 * 그래서 호스트 프로세스의 실행 인자에 우리 서버 이름이 있는지 직접 확인한다.
 */
function isChannelEnabled(hostPid) {
  if (!hostPid) return false;
  try {
    const cmd = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       `(Get-CimInstance Win32_Process -Filter "ProcessId=${hostPid}").CommandLine`],
      { windowsHide: true, timeout: 8000 }).toString();
    if (!/--channels|--dangerously-load-development-channels/.test(cmd)) return false;
    // 플래그는 있는데 다른 채널만 지정한 경우도 거른다
    return /(^|[\s:])(server:)?fleetview(\s|$|@)/.test(cmd);
  } catch { return false; }
}

const me = findSession();
const sessionId = me ? me.sessionId : null;
const sessionName = me ? (me.name || '') : '';
const cwd = me ? (me.cwd || '') : process.cwd();

// stderr 로만 로그를 남긴다. stdout 은 MCP 프로토콜 전용이라 건드리면 안 된다.
const log = (...a) => process.stderr.write('[fleetview-channel] ' + a.join(' ') + '\n');
log(sessionId ? `세션 ${sessionId} (${sessionName}) 에 붙었습니다` : '세션을 특정하지 못했습니다');

// ---------- MCP 서버 ----------------------------------------------------------
const mcp = new Server(
  { name: 'fleetview', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },   // 이게 있어야 채널로 등록된다
      // 답장 도구는 두지 않는다.
      // 답은 세션 기록에서 읽어 오므로 도구가 할 일이 "끝났다" 신호뿐인데,
      // 그 신호 하나에 모델 턴이 통째로 하나 더 든다(맥락 전체를 다시 읽는다).
      // 2초 빨라지자고 치르기엔 비싸다.
    },
    instructions:
      'FleetView 대시보드에서 보낸 메시지가 <channel source="fleetview" msg_id="..."> 로 도착합니다. ' +
      '평소처럼 작업하고 평소처럼 답하세요. 화면에 쓴 답이 그대로 대시보드에도 보입니다. ' +
      '따로 보고하거나 도구를 부를 필요가 없습니다.',
  },
);

// ---------- FleetView 롱폴링 --------------------------------------------------
async function register() {
  try {
    await fetch(SERVER + '/api/channel/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, name: sessionName, cwd, pid: process.pid }),
    });
    return true;
  } catch { return false; }
}

async function pump() {
  let lastRegister = 0;
  while (true) {
    let data;
    try {
      // 반드시 시간 제한을 둔다. 서버가 롱폴링을 붙잡은 채로 죽으면 응답도 오류도
      // 오지 않아 여기서 영원히 멈춰 버린다. 서버는 25초까지 붙잡으므로 그보다 넉넉히 준다.
      const r = await fetch(SERVER + '/api/channel/poll?sessionId=' + encodeURIComponent(sessionId || ''),
        { signal: AbortSignal.timeout(40000) });
      data = await r.json();

      // 서버가 재시작됐을 수 있으니 가끔 등록을 다시 알린다
      if (Date.now() - lastRegister > 60000) { lastRegister = Date.now(); register(); }
    } catch {
      await new Promise((r) => setTimeout(r, 3000));   // 서버가 꺼져 있으면 재시도
      await register();
      lastRegister = Date.now();
      continue;
    }
    for (const m of (data && data.messages) || []) {
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: m.text,
            meta: { msg_id: m.id, source: 'fleetview' },
          },
        });
        log('메시지 주입:', m.id);
      } catch (e) {
        log('주입 실패:', e.message);
      }
    }
  }
}

(async () => {
  await mcp.connect(new StdioServerTransport());
  log('MCP 연결됨');
  if (!sessionId) {
    log('세션 id 를 못 찾아 폴링을 시작하지 않습니다');
    return;
  }
  if (!isChannelEnabled(me.hostPid)) {
    log('이 세션은 --channels 없이 시작됐습니다. 채널로 등록하지 않습니다.');
    log('채널로 쓰려면: claude --dangerously-load-development-channels server:fleetview');
    return;   // 도구는 그대로 노출되지만 주입은 하지 않는다
  }
  await register();
  pump().catch((e) => log('폴링 중단:', e.message));
})();
