'use strict';
/**
 * 세션 창 바로가기.
 *
 * 세션마다 창을 찾는 방법이 다르다.
 *
 *   Claude 데스크톱 앱 세션
 *     세션의 claude.exe 는 창이 없고, 부모인 앱이 창을 가진다.
 *     프로세스 조상을 거슬러 올라가 창을 찾는다.
 *     한계: 앱 창은 하나뿐이라 세션별 탭까지는 못 고른다. 앱만 앞으로 나온다.
 *
 *   FleetView 가 띄운 터미널 세션
 *     배치 파일에서 `title FleetView - <id8>` 을 걸어두므로 창 제목으로 찾는다.
 *
 *   그 외 터미널 세션
 *     콘솔 호스트가 별도 프로세스라 조상 추적으로는 안 잡힌다.
 *     이 경우 창을 못 찾았다고 알리고, 호출부가 새 터미널을 여는 쪽으로 넘어간다.
 */
const { execFile } = require('child_process');

const ps = (script) => new Promise((resolve, reject) => {
  execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 20000 },
    (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())));
});

// PowerShell 쪽 창 조작 도우미. 문자열로 넣기 때문에 한 번만 정의해 재사용한다.
const WIN32 = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FvWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc f, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
"@ -ErrorAction SilentlyContinue
function Get-FvWindows {
  $out = New-Object System.Collections.ArrayList
  $cb = [FvWin+EnumWindowsProc]{
    param($h, $l)
    if ([FvWin]::IsWindowVisible($h)) {
      $len = [FvWin]::GetWindowTextLength($h)
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder ($len + 1)
        [FvWin]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
        $wpid = 0
        [FvWin]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
        [void]$out.Add([pscustomobject]@{ H = $h; Pid = [int]$wpid; Title = $sb.ToString() })
      }
    }
    return $true
  }
  [FvWin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $out
}
function Focus-Fv([IntPtr]$h) {
  [FvWin]::ShowWindow($h, 9) | Out-Null      # SW_RESTORE
  [FvWin]::SetForegroundWindow($h) | Out-Null
}
`;

/**
 * @param {number}  pid    세션 프로세스 id
 * @param {string=} titleHint  창 제목에 들어 있을 문자열 (FleetView 가 띄운 세션)
 * @returns {Promise<{focused:boolean, how?:string, title?:string}>}
 */
async function focusSessionWindow(pid, titleHint) {
  const hint = (titleHint || '').replace(/'/g, "''");
  const script = WIN32 + `
$wins = Get-FvWindows

# 1) 프로세스 조상을 거슬러 올라가며 창을 찾는다 (데스크톱 앱 세션)
$cur = ${pid}
$found = $null
for ($i = 0; $i -lt 6 -and $cur -and -not $found; $i++) {
  $found = $wins | Where-Object { $_.Pid -eq $cur } | Select-Object -First 1
  if (-not $found) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
    if (-not $p) { break }
    $cur = [int]$p.ParentProcessId
  }
}
if ($found) {
  Focus-Fv $found.H
  Write-Output ("OK|ancestor|" + $found.Title)
  exit 0
}

# 2) 창 제목으로 찾는다 (FleetView 가 띄운 터미널 세션)
if ('${hint}' -ne '') {
  $byTitle = $wins | Where-Object { $_.Title -like "*${hint}*" } | Select-Object -First 1
  if ($byTitle) {
    Focus-Fv $byTitle.H
    Write-Output ("OK|title|" + $byTitle.Title)
    exit 0
  }
}

Write-Output "NONE||"
`;
  const out = await ps(script);
  const [status, how, title] = out.split('|');
  return status === 'OK'
    ? { focused: true, how, title: title || '' }
    : { focused: false };
}

module.exports = { focusSessionWindow };
