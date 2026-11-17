@echo off
title KlipDed Helper
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo [!] Python not found. Install it from https://www.python.org/downloads/
  echo     and tick "Add python.exe to PATH" during setup.
  pause
  exit /b 1
)
python -c "import yt_dlp" >nul 2>nul
if errorlevel 1 (
  echo Installing yt-dlp ...
  python -m pip install -U "yt-dlp[default]"
)
python klipded_helper.py %*
pause
