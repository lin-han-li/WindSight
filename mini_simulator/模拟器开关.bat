@echo off
chcp 65001 >nul
setlocal

REM 中文入口：启动手动上报模拟器（Web UI）
cd /d %~dp0
call "%~dp0sim_ctl.bat" %*

endlocal
