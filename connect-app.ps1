# FleetView - 데스크톱 앱을 디버그 포트를 붙여 다시 띄운다.
#
# 이 스크립트는 반드시 사용자가 직접 실행해야 한다(탐색기에서 더블클릭).
# FleetView 서버가 대신 실행하면 안 되는 이유: Claude Code 가 Claude 앱 안에서 돌 때
# 그 앱이 곧 상위 프로세스라, 서버가 앱을 종료하면 자기 자신까지 함께 내려간다.
# 탐색기가 띄우면 부모가 explorer.exe 라서 그 문제가 없다.

param(
  [ValidateSet('chatgpt')]
  [string]$App = 'chatgpt'
)

$ErrorActionPreference = 'Stop'

$SPEC = @{
  chatgpt = @{ Label = 'ChatGPT'; Package = 'OpenAI.Codex'; Exe = 'ChatGPT.exe'; Port = 9333 }
}[$App]

Write-Host ""
Write-Host "  FleetView - $($SPEC.Label) 앱 연결" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

# --- 1. 실행 파일 경로 알아내기 -------------------------------------------------
# 스토어 앱이라 경로에 버전이 박혀 있고 자동 업데이트로 바뀐다. 매번 새로 찾는다.
$pattern = "*\WindowsApps\$($SPEC.Package)_*\app\$($SPEC.Exe)"
$exe = (Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like $pattern } |
        Select-Object -First 1).Path

if (-not $exe) {
  $pkg = Get-AppxPackage -Name $SPEC.Package -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pkg) { $exe = Join-Path $pkg.InstallLocation "app\$($SPEC.Exe)" }
}

if (-not $exe -or -not (Test-Path $exe)) {
  Write-Host "  $($SPEC.Label) 앱을 찾지 못했습니다. 설치되어 있는지 확인해 주세요." -ForegroundColor Red
  Read-Host "`n  엔터를 누르면 닫힙니다"
  exit 1
}
Write-Host "  실행 파일 : $exe"


# --- 2. 이미 디버그 포트가 열려 있으면 그대로 둔다 -------------------------------
try {
  Invoke-WebRequest -Uri "http://127.0.0.1:$($SPEC.Port)/json/version" -UseBasicParsing -TimeoutSec 2 | Out-Null
  Write-Host "  이미 연결되어 있습니다 (포트 $($SPEC.Port)). 할 일이 없습니다." -ForegroundColor Green
  Read-Host "`n  엔터를 누르면 닫힙니다"
  exit 0
} catch { }

# --- 3. 확인 ------------------------------------------------------------------
$targets = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
Write-Host "  종료 대상 : $($targets.Count) 개 프로세스"
Write-Host ""
Write-Host "  $($SPEC.Label) 앱을 껐다가 디버그 포트를 붙여 다시 띄웁니다." -ForegroundColor Yellow
Write-Host "  대화 내용은 서버에 저장되어 있으므로 사라지지 않습니다." -ForegroundColor DarkGray
Write-Host ""
$answer = Read-Host "  진행할까요? (y/n)"
if ($answer -ne 'y' -and $answer -ne 'Y') {
  Write-Host "  취소했습니다."
  exit 0
}

# --- 4. 종료 후 재실행 ---------------------------------------------------------
if ($targets.Count -gt 0) {
  Write-Host "  종료 중..."
  $targets | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}

Write-Host "  디버그 포트 $($SPEC.Port) 로 다시 띄우는 중..."
$outLog = Join-Path $env:TEMP "fleetview-$App-out.log"
$errLog = Join-Path $env:TEMP "fleetview-$App-err.log"
Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$($SPEC.Port)" `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog

# --- 5. 포트가 열릴 때까지 대기 -------------------------------------------------
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$($SPEC.Port)/json/version" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $ok = $true
    break
  } catch { }
}

Write-Host ""
if ($ok) {
  Write-Host "  연결됐습니다." -ForegroundColor Green
  Write-Host "  FleetView 대시보드(http://localhost:7777)에서 $($SPEC.Label) 앱 카드가" -ForegroundColor Green
  Write-Host "  '연결됨' 으로 바뀝니다. 몇 초 걸릴 수 있습니다." -ForegroundColor Green
  Write-Host ""
  Write-Host "  앞으로 앱을 켤 때는 시작 메뉴 대신 이 스크립트로 켜야" -ForegroundColor DarkGray
  Write-Host "  연결이 유지됩니다." -ForegroundColor DarkGray
} else {
  $said = ((Get-Content $outLog, $errLog -ErrorAction SilentlyContinue) -join "`n").Trim()

  if ($said -match 'refusing to start') {
    Write-Host "  이 앱은 디버그 연결을 거부합니다." -ForegroundColor Red
    Write-Host "  앱이 스스로 막아둔 것이라 우회할 방법이 없습니다:" -ForegroundColor DarkGray
    Write-Host "    $said" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  대신 claude.ai 를 크롬 탭으로 열어두시면" -ForegroundColor Yellow
    Write-Host "  FleetView 에서 동일하게 대화·이동·워크플로우 배정이 됩니다." -ForegroundColor Yellow
    Write-Host "  앱은 지금 플래그 없이 다시 켜집니다." -ForegroundColor DarkGray
    Start-Process -FilePath $exe
  } else {
    Write-Host "  다시 띄웠지만 디버그 포트가 열리지 않았습니다." -ForegroundColor Red
    if ($said) { Write-Host "    $said" -ForegroundColor DarkGray }
    Write-Host "  앱이 완전히 종료되지 않았을 수 있습니다. 트레이 아이콘에서 완전히 끈 뒤" -ForegroundColor Red
    Write-Host "  다시 실행해 보세요." -ForegroundColor Red
  }
}

Read-Host "`n  엔터를 누르면 닫힙니다"
