@echo off
rem Sofia's Resto-Lounge - prepare this staff PC (asks for administrator rights).
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0Install-SofiaStaffPC.ps1\"'"
