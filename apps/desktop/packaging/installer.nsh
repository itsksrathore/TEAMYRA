; Scope shutdown to this installation. Never kill a provider or a different
; TEAMYRA checkout by executable name. Refuse replacement while a runner lives.
!macro prepareTeamyraInstall
  System::Call 'kernel32::SetEnvironmentVariable(t "TEAMYRA_INSTALL_DIR", t "$INSTDIR")i.r0'
  nsExec::ExecToStack /TIMEOUT=30000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "try { $$dir = [IO.Path]::GetFullPath($$env:TEAMYRA_INSTALL_DIR); $$core = [IO.Path]::Combine($$dir, 'resources', 'teamyra-core', 'teamyra-core.exe'); $$app = [IO.Path]::Combine($$dir, 'TEAMYRA.exe'); $$items = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and ($$_.ExecutablePath -eq $$core -or $$_.ExecutablePath -eq $$app) }); if (@($$items | Where-Object { $$_.ExecutablePath -eq $$core -and $$_.CommandLine -notmatch ' (__wake-gateway|mcp http|__desktop-api (chatgpt.workspace.status|observability.usage|worktree.list|memory.list))\b' }).Count) { exit 2 }; foreach ($$item in $$items) { Stop-Process -Id $$item.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500; if (@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -eq $$core -or $$_.ExecutablePath -eq $$app }).Count) { exit 3 }; exit 0 } catch { exit 3 }"`
  Pop $0
  Pop $1
  System::Call 'kernel32::SetEnvironmentVariable(t "TEAMYRA_INSTALL_DIR", p 0)'
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "TEAMYRA background processes could not be closed safely (code $0). Finish active jobs, close TEAMYRA, then retry. No application files have been replaced." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

; Do not use the default name-wide fallback or directory-prefix matching:
; another checkout or a similarly named installation may be doing active work.
!macro customCheckAppRunning
  !insertmacro prepareTeamyraInstall
!macroend
