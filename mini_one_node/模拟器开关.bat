@echo off
chcp 65001 >nul
setlocal

cd /d %~dp0
REM Wrapper to open the mini simulator controller
call "%~dp0sim_ctl.bat" %*

endlocal
