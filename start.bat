@echo off
set PROJECT=d:\projects\Family-Growth-Radar
set PY=%PROJECT%\.venv\Scripts\python.exe

start "backend" cmd /k "cd /d %PROJECT% && %PY% -m uvicorn backend.main:app --reload --port 8000"
start "frontend" cmd /k "cd /d %PROJECT%\frontend && npx expo start"
