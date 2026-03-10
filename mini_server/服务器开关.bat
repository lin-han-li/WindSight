@echo off
chcp 65001 >nul
setlocal

cd /d %~dp0
REM 中文入口：打开交互式控制台（若终端对中文文件名乱码，建议直接双击 server_toggle.bat）
call "%~dp0server_toggle.bat" %*

endlocal
