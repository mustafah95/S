@echo off
rem Sofia's Resto-Lounge - double-click to install (Windows asks for administrator rights).
rem Advanced options: run Install-Sofia.ps1 from an administrator PowerShell (see README.txt).
setlocal
cd /d "%~dp0"
rem Started from inside the ZIP window, Windows copies only this file to a temporary folder: stop with a clear message.
if exist "%~dp0Install-Sofia.ps1" if exist "%~dp0bundle.json" if exist "%~dp0payload\*.tar.gz" goto run
echo.
echo   Sofia's Resto-Lounge - installer
echo   ---------------------------------
echo   The installation files were not found next to Install-Sofia.cmd.
echo.
echo   Please extract the whole ZIP file first:
echo     1. In Downloads, right-click the ZIP file and choose "Extract All..."
echo     2. Open the extracted folder SofiaSetup-...-windows
echo     3. Double-click Install-Sofia.cmd in that folder
echo.
echo   Do not start it from inside the ZIP window.
echo.
pause
exit /b 1
:run
rem -NoExit keeps the installer window open, so any message stays readable.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File \"%~dp0Install-Sofia.ps1\"'"
