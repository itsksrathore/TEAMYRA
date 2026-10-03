@echo off
setlocal
set "ROOT=%~dp0.."
python "%ROOT%\bridge\teamyra_cli.py" %*
exit /b %ERRORLEVEL%
