@echo off
rem Sofia's Resto-Lounge - double-click to install (Windows asks for administrator rights).
rem Advanced options: run Install-Sofia.ps1 from an administrator PowerShell (see README.txt).
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0Install-Sofia.ps1\"'"
