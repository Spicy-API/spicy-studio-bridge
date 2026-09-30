@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0"
set result=1
where node >nul 2>nul
if errorlevel 1 goto no_node
node -e "var v=process.versions.node.split('.');process.exit(Number(v[0])>22||(Number(v[0])===22&&Number(v[1])>=13)?0:1)" >nul 2>nul
if errorlevel 1 goto no_node
node "%~dp0connect.mjs" %*
set result=%errorlevel%
goto finished
:no_node
echo A supported Node.js version was not found.
echo Install Node.js 22.13 or newer: https://nodejs.org/en/download
echo Then reopen this launcher. Nothing was configured.
:finished
echo.
pause
popd
endlocal & exit /b %result%
