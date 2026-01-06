@echo off
chcp 65001 >nul
setlocal

REM 中文入口：启动 WindSight 模拟器（sim.py）
cd /d %~dp0
call "%~dp0sim_ctl.bat"

endlocal


