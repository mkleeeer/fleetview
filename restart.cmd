@echo off
chcp 65001 >nul
title FleetView 재시작

echo 서버를 다시 시작합니다. (실행 중인 서버 창은 그대로 두세요)
echo.

powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess ^| Select-Object -Unique ^| ForEach-Object { Stop-Process -Id $_ -Force }; Write-Host '  서버를 내렸습니다. 서버 창이 3초 뒤 새 코드로 다시 띄웁니다.' } else { Write-Host '  실행 중인 서버가 없습니다. start.cmd 를 실행하세요.' }"

echo.
timeout /t 6 /nobreak >nul

powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue; if ($c) { Write-Host '  올라왔습니다. 브라우저를 새로고침하세요.' } else { Write-Host '  아직 안 올라왔습니다. 서버 창을 확인하세요.' }"

echo.
pause
