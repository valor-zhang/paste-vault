; Custom uninstall step: remove the "start with Windows" entry this app writes.
; Without it, uninstalling leaves a Run entry pointing at a deleted exe, and
; Windows keeps trying to launch it on every boot.
;
; The value name is the AppUserModelId Electron uses on Windows (verified against
; the real registry: com.local.pastemanager). It must be ASCII here - NSIS reads
; .nsh as ANSI and non-ASCII text would be mangled (same trap as .cmd/.ps1).

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.local.pastemanager"
!macroend
