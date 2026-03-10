@echo off
chcp 65001 >nul
setlocal

cd /d %~dp0
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION="

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sim_ctl.ps1" %ACTION%

endlocal
