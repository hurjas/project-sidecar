@echo off
title Project SideCar

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node is not installed, so the board cannot store your work in tasks.json.
  echo.
  echo Install Node 18 or newer from https://nodejs.org and run this file again.
  echo Or double-click project-plan-dashboard.html to use the board in your browser without Node.
  echo.
  pause
  exit /b 1
)

echo Starting Project SideCar...
echo Keep this window open while you work. Close it or press Ctrl+C to stop.
echo.

start "" http://localhost:8080/project-plan-dashboard.html
node serve-dashboard.js
