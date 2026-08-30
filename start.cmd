@echo off
chcp 65001 >nul
title FleetView 서버
cd /d "%~dp0"

echo FleetView 서버를 시작합니다.  http://localhost:7777
echo 이 창을 닫으면 서버가 꺼집니다. 기록은 fleetview.log 에 쌓입니다.
echo 코드가 바뀌면 알아서 다시 뜹니다. 따로 재시작할 필요 없습니다.
echo.

:loop
node server\index.js >> fleetview.log 2>&1
echo.
echo [%date% %time%] 서버가 종료됐습니다. 3초 뒤 다시 시작합니다. Ctrl+C 로 중단하세요.
timeout /t 3 /nobreak >nul
goto loop
