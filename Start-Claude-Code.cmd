@echo off
set "PATH=%APPDATA%\npm;%LOCALAPPDATA%\agy\bin;%PATH%"
if "%~1"=="" (cd /d D:\Ai-editing) else (cd /d "%~1")
"C:\Users\kiran\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
