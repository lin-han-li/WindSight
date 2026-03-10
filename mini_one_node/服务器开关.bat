@echo off
chcp 65001 >nul
setlocal

cd /d %~dp0
REM Wrapper to open the mini server controller
call "%~dp0server_toggle.bat" %*

endlocal
