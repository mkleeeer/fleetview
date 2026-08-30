@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue; if ($c) { Write-Host '이미 실행 중입니다.' } else { Start-Process node -ArgumentList 'server\index.js' -WorkingDirectory $PWD -WindowStyle Hidden; Start-Sleep 5; Write-Host 'FleetView 를 켰습니다.' }"

start "" http://localhost:7777
