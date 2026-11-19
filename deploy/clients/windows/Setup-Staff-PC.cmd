@echo off
rem Sofia's Resto-Lounge - prepare this staff PC (asks for administrator rights).
setlocal
cd /d "%~dp0"
if exist "%~dp0Install-SofiaStaffPC.ps1" goto run
echo.
echo   Install-SofiaStaffPC.ps1 was not found next to this file.
echo   Extract the whole ZIP file first (right-click the ZIP file - "Extract All..."),
echo   then double-click Setup-Staff-PC.cmd in the extracted 2-Staff-Windows-PC folder.
echo.
pause
exit /b 1
:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File \"%~dp0Install-SofiaStaffPC.ps1\"'"
