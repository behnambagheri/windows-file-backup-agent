@echo off
setlocal
set "AGENT_HOME=%~dp0"
"%~dp0node\node.exe" "%~dp0app\src\cli.js" %*
endlocal
