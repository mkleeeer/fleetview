'use strict';
/**
 * ~/.claude/projects/<프로젝트>/<세션id>.jsonl 을 읽어 Claude Code 세션 현황을 만든다.
 * 트랜스크립트 파일은 수십 MB까지 커지므로 항상 꼬리 몇 KB만 읽는다.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 96 * 1024;
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 최근 7일 세션만 판에 올린다

function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString('utf8'), truncated: len < size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function readHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.min(bytes, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function parseLines(text, { dropFirst }) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift(); // 꼬리를 읽었으면 첫 줄은 잘렸을 수 있다
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 잘린 줄 무시 */ }
  }
  return out;
}

/** content 배열/문자열에서 사람이 읽을 텍스트만 뽑는다 */
function textOf(entry) {
  const c = entry && entry.message && entry.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function toolNameOf(entry) {
  const c = entry && entry.message && entry.message.content;
  if (!Array.isArray(c)) return null;
  const use = c.find((b) => b && b.type === 'tool_use');
  return use ? use.name : null;
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** 훅으로 만들어진 시스템/명령 잡음을 걸러 진짜 사용자 발화만 남긴다 */
function isRealUserText(t) {
  if (!t) return false;
  if (t.startsWith('<command-name>')) return false;
  if (t.startsWith('<local-command')) return false;
  if (t.startsWith('Caveat:')) return false;
  if (t.startsWith('<system-reminder>')) return false;
  return true;
}

function decodeProjectDir(name) {
  // Claude Code 는 경로를 폴더명으로 인코딩한다. 원본 cwd 는 트랜스크립트 안에 들어있으므로
  // 여기서는 표시용 이름만 만든다.
  return name.replace(/^[A-Za-z]--/, '').replace(/-+/g, '/').replace(/\/+$/, '');
}

function analyze(file, projectDirName) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (Date.now() - st.mtimeMs > MAX_AGE_MS) return null;
  if (st.size === 0) return null;

  const tail = readTail(file, TAIL_BYTES);
  if (!tail) return null;
  const entries = parseLines(tail.text, { dropFirst: tail.truncated });
  if (!entries.length) return null;

  // 제목: 파일 앞부분의 첫 사용자 발화
  let title = '';
  let cwd = '';
  for (const e of parseLines(readHead(file, 64 * 1024), { dropFirst: false })) {
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!title && e.type === 'user') {
      const t = textOf(e);
      if (isRealUserText(t)) title = clip(t, 70);
    }
    if (title && cwd) break;
  }

  // 꼬리에서 최근 활동 파악
  let lastUserText = '';
  let lastAssistantText = '';
  let lastTool = null;
  let lastRole = null;
  for (const e of entries) {
    if (e.cwd) cwd = e.cwd;
    if (e.type === 'user') {
      const t = textOf(e);
      if (isRealUserText(t)) { lastUserText = t; lastRole = 'user'; }
    } else if (e.type === 'assistant') {
      const t = textOf(e);
      if (t) lastAssistantText = t;
      const tool = toolNameOf(e);
      if (tool) lastTool = tool;
      lastRole = 'assistant';
    }
  }

  const ageMs = Date.now() - st.mtimeMs;
  // 상태 추론: 마지막이 사용자 차례면 AI가 일하는 중, 어시스턴트 차례면 내 답변 대기.
  let status;
  if (ageMs < 45 * 1000) status = lastRole === 'user' ? 'working' : 'waiting';
  else if (ageMs < 30 * 60 * 1000) status = 'idle';
  else status = 'stale';

  const id = path.basename(file, '.jsonl');
  return {
    kind: 'claude-code',
    provider: 'claude',
    id,
    key: 'cc:' + id,
    title: title || clip(lastUserText, 70) || '(제목 없음)',
    project: cwd || decodeProjectDir(projectDirName),
    projectName: path.basename(cwd || decodeProjectDir(projectDirName)) || '?',
    status,
    lastTool,
    lastUser: clip(lastUserText, 160),
    lastAssistant: clip(lastAssistantText, 200),
    updatedAt: st.mtimeMs,
    file,
  };
}


/**
 * 지금 터미널/앱에서 열려 있는 세션을 알아낸다.
 *
 * Claude Code 는 실행 중인 세션마다 ~/.claude/sessions/<pid>.json 을 남긴다.
 * 거기에 sessionId 와 pid 가 들어 있어서, 프로세스가 살아 있는지 확인하면
 * "지금 누가 쓰고 있는 세션"을 정확히 가려낼 수 있다.
 *
 * 이게 중요한 이유: 열려 있는 세션에 밖에서 메시지를 보내면 그 프로세스는
 * 자기 메모리로 대화 중이라 끼어들 수 없고, 기록이 곁가지로 갈라진다.
 * 꺼져 있는 세션에 보내면 선형으로 정상 연결된다.
 */
function liveSessions() {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  const out = new Map();
  let files;
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!j.sessionId || !j.pid) continue;
    let alive = false;
    try { process.kill(j.pid, 0); alive = true; } catch { alive = false; }
    if (!alive) continue;
    out.set(j.sessionId, {
      pid: j.pid, name: j.name || '', kind: j.kind || '', entrypoint: j.entrypoint || '',
    });
  }
  return out;
}

function scan() {
  const live = liveSessions();
  let projects;
  try { projects = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(ROOT, p.name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const s = analyze(path.join(dir, f), p.name);
      if (!s) continue;
      const l = live.get(s.id);
      s.live = !!l;                       // 지금 열려 있는가
      s.channel = false;                  // 채널 연결 여부는 index.js 에서 채운다
      s.liveInfo = l || null;             // pid / 표시 이름 / 실행 형태
      if (l) s.status = 'open';           // 다른 상태보다 이게 우선이다
      out.push(s);
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

module.exports = { scan, liveSessions, ROOT };
