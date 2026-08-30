@echo off
chcp 65001 >nul
title FleetView - Connect ChatGPT App
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0connect-app.ps1" -App chatgpt
if errorlevel 1 (
  echo.
  echo [!] PowerShell exited with an error.
)
pause
