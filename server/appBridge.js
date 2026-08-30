'use strict';
/**
 * ChatGPT 데스크톱 앱 연동.
 *
 * Electron 이라 --remote-debugging-port 로 띄우면 크롬 탭과 똑같이 제어된다.
 * Claude 앱은 디버그 스위치가 붙으면 기동을 거부하므로 대상이 아니다.
 * Claude 는 claude-code(CLI) / anthropic-api / claude-tab 어댑터로 붙는다.
 * 앱은 껍데기 창(page) 안에 chatgpt.com / claude.ai 를 webview 로 띄우므로,
 * 실제 대화 화면은 webview 타깃 쪽이다.
 *
 * 앱이 스토어 패키지라 경로에 버전이 박혀 있고 자동 업데이트로 바뀐다.
 * 그래서 경로는 항상 실행 중인 프로세스나 패키지 정보에서 새로 알아낸다.
 */
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const cdp = require('./cdp');
const store = require('./store');

const AGENT_FILE = path.join(__dirname, '..', 'extension', 'pageAgent.js');

const APPS = {
  chatgpt: {
    key: 'chatgpt', label: 'ChatGPT 앱', provider: 'chatgpt',
    processName: 'ChatGPT', packageName: 'OpenAI.Codex', exeName: 'ChatGPT.exe',
    port: 9333, hostMatch: 'chatgpt.com',
    // 이름만 보고 고르면 안 된다. 예를 들어 claude 라는 이름의 프로세스에는
    // 데스크톱 앱과 Claude Code CLI 가 섞여 있어서, 설치 경로까지 맞춰야 안전하다.
    pathMatch: '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe',
  },
};

const ps = (script) => new Promise((resolve, reject) => {
  execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())));
});

/** 실행 파일 경로를 실행 중인 프로세스 → 설치 패키지 순으로 알아낸다 */
async function resolveExe(app) {
  const fromProc = await ps(
    `$p = Get-Process ${app.processName} -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Path -like '${app.pathMatch}' } | Select-Object -First 1; ` +
    `if ($p) { $p.Path }`);
  if (fromProc) return fromProc;

  const fromPkg = await ps(
    `$p = Get-AppxPackage -Name '${app.packageName}' -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
    `if ($p) { Join-Path $p.InstallLocation 'app\\${app.exeName}' }`);
  if (fromPkg && fs.existsSync(fromPkg)) return fromPkg;

  throw new Error(app.label + ' 실행 파일을 찾지 못했습니다. 앱이 설치되어 있는지 확인해 주세요.');
}

/**
 * 내가 딛고 선 가지를 자르지 않기 위한 검사.
 *
 * Claude Code 는 Claude 데스크톱 앱 안에서 실행될 수 있고, 그 경우 CLI 프로세스의
 * 부모가 곧 앱이다. 앱을 종료하면 이 서버와 사용자의 작업 세션이 함께 내려간다.
 * 그래서 종료 후보 중에 "나 자신의 조상"이 하나라도 있으면 아예 진행하지 않는다.
 */
async function findSelfAncestors() {
  const out = await ps(
    `$map = @{}; ` +
    `Get-CimInstance Win32_Process | ForEach-Object { $map[[int]$_.ProcessId] = [int]$_.ParentProcessId }; ` +
    `$roots = @(${process.pid}); ` +
    `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ` +
    `  Where-Object { $_.ExecutablePath -like '*claude-code*' } | ` +
    `  ForEach-Object { $roots += [int]$_.ProcessId }; ` +
    `$seen = @{}; ` +
    `foreach ($r in $roots) { $cur = $r; $n = 0; ` +
    `  while ($cur -and $map.ContainsKey($cur) -and $n -lt 24) { $seen[$cur] = $true; $cur = $map[$cur]; $n++ } ` +
    `  if ($cur) { $seen[$cur] = $true } }; ` +
    `$seen.Keys`);
  return new Set(out.split(/\s+/).filter(Boolean).map(Number));
}

/** 앱을 종료하고 디버그 포트를 붙여 다시 띄운다 */
async function relaunch(appKey) {
  const app = APPS[appKey];
  if (!app) throw new Error('알 수 없는 앱: ' + appKey);

  const exe = await resolveExe(app);

  // 종료 대상은 "방금 알아낸 실행 파일 경로와 정확히 같은" 프로세스로만 한정한다.
  // 이름이나 와일드카드로 고르면 안 된다. claude 라는 이름으로는 데스크톱 앱과
  // Claude Code CLI 가 함께 도는데, 후자를 죽이면 사용자의 작업 세션이 날아간다.
  const victims = await ps(
    `Get-Process -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' } | ` +
    `Select-Object -ExpandProperty Id`);
  const ids = victims.split(/\s+/).filter(Boolean);

  const ancestors = await findSelfAncestors();
  const fatal = ids.filter((id) => ancestors.has(Number(id)));
  if (fatal.length) {
    throw new Error(
      app.label + ' 은(는) 지금 이 프로그램을 실행하고 있는 상위 프로세스입니다(PID ' + fatal.join(', ') + '). ' +
      '여기서 종료하면 FleetView 자신까지 함께 내려가므로 진행할 수 없습니다. ' +
      'fleetview 폴더의 connect-' + app.key + '-app.cmd 를 탐색기에서 더블클릭해 주세요. ' +
      '그쪽은 탐색기가 띄우기 때문에 앱을 안전하게 껐다 켤 수 있습니다.');
  }

  if (ids.length) {
    await ps(`Stop-Process -Id ${ids.join(',')} -Force -ErrorAction SilentlyContinue`);
  }
  await new Promise((r) => setTimeout(r, 2500));

  spawn(exe, ['--remote-debugging-port=' + app.port], { detached: true, stdio: 'ignore' }).unref();

  // 포트가 열릴 때까지 최대 25초 기다린다
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await cdp.isUp(app.port)) return { ok: true, exe, port: app.port };
  }
  throw new Error(app.label + ' 을(를) 다시 띄웠지만 디버그 포트가 열리지 않았습니다.');
}

/** 대화 화면에 해당하는 타깃을 고른다 (앱 껍데기가 아니라 안쪽 webview) */
async function chatTarget(app) {
  const list = await cdp.targets(app.port);
  const usable = list.filter((t) => t.webSocketDebuggerUrl);
  return usable.find((t) => t.type === 'webview' && (t.url || '').includes(app.hostMatch))
      || usable.find((t) => (t.url || '').includes(app.hostMatch))
      || usable.find((t) => t.type === 'webview')
      || usable.find((t) => t.type === 'page' && !(t.url || '').includes('avatar-overlay'));
}

/** 확장과 공유하는 페이지 조작 코드를 평가용 표현식으로 감싼다 */
function agentExpression(action, text) {
  const src = fs.readFileSync(AGENT_FILE, 'utf8').replace(/^\s*export\s+/m, '');
  return `(() => { ${src}\nreturn pageAgent(${JSON.stringify(action)}, ${JSON.stringify(text || '')}); })()`;
}

async function run(appKey, action, text) {
  const app = APPS[appKey];
  if (!app) throw new Error('알 수 없는 앱: ' + appKey);
  if (!(await cdp.isUp(app.port))) {
    throw new Error(app.label + ' 이 디버그 모드로 떠 있지 않습니다. 대시보드에서 「앱 연결」을 눌러 주세요.');
  }
  const t = await chatTarget(app);
  if (!t) throw new Error(app.label + ' 에서 대화 화면을 찾지 못했습니다.');
  return cdp.evaluate(t.webSocketDebuggerUrl, agentExpression(action, text));
}

async function focus(appKey) {
  const app = APPS[appKey];
  const t = await chatTarget(app);
  if (t) { try { await cdp.bringToFront(t.webSocketDebuggerUrl); } catch {} }
  // CDP 만으로는 OS 창이 앞으로 안 나오는 경우가 있어 Win32 로 한 번 더 올린다
  await ps(
    `Add-Type -Name W -Namespace F -MemberDefinition ` +
    `'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);` +
    `[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);'; ` +
    `$p = Get-Process ${app.processName} -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '${app.pathMatch}' } | Select-Object -First 1; ` +
    `if ($p) { [F.W]::ShowWindow($p.MainWindowHandle, 9); [F.W]::SetForegroundWindow($p.MainWindowHandle) }`
  ).catch(() => {});
  return { focused: true };
}

/** 대시보드에 올릴 앱 세션 현황 */
async function snapshot() {
  const out = [];
  for (const app of Object.values(APPS)) {
    const up = await cdp.isUp(app.port);
    let title = '';
    let url = '';
    if (up) {
      try {
        const t = await chatTarget(app);
        if (t) { title = t.title || ''; url = t.url || ''; }
      } catch { /* 앱이 막 뜨는 중일 수 있다 */ }
    }
    out.push({
      kind: 'app', key: 'app:' + app.key, id: app.key,
      provider: app.provider, label: app.label,
      connected: up, title, url, port: app.port,
    });
  }
  return out;
}

module.exports = { APPS, relaunch, run, focus, snapshot, chatTarget };
