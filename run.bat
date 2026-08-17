@echo off
REM Double-click this to start the Josudi Gesture Jukebox.
REM It starts the local web server, then opens your browser at it.
cd /d "%~dp0"
start "" http://localhost:5173
node server.js
pause
