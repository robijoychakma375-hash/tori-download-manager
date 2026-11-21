!macro NSIS_HOOK_PREINSTALL
  ; Guard non-silent installs (interactive GUI and Tauri /P /UPDATE auto-updater)
  ; against stale temporary/QA paths left in HKCU\Software\tori\TORI Download Manager.
  ; Automated silent installs (/S /D=<path>) are intentionally allowed to target custom paths.
  ${IfNot} ${Silent}
    ${StrCase} $R8 "$INSTDIR" "L"
    ${StrLoc} $R9 "$R8" "\temp\" ">"
    ${If} $R9 != ""
      StrCpy $R7 "$INSTDIR"
      DetailPrint "Detected stale temporary install path ($INSTDIR); redirecting to $LOCALAPPDATA\${PRODUCTNAME}"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
      CreateDirectory "$INSTDIR"
      SetOutPath "$INSTDIR"
      RMDir "$R7"
    ${Else}
      ${StrLoc} $R9 "$R8" "_qa" ">"
      ${If} $R9 != ""
        StrCpy $R7 "$INSTDIR"
        DetailPrint "Detected stale QA install path ($INSTDIR); redirecting to $LOCALAPPDATA\${PRODUCTNAME}"
        StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
        CreateDirectory "$INSTDIR"
        SetOutPath "$INSTDIR"
        RMDir "$R7"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Register Native Messaging Host via built-in registration
  IfFileExists "$INSTDIR\tdm-native-host.exe" 0 +3
    ExecWait '"$INSTDIR\tdm-native-host.exe" --register'
    Goto postinstall_done
  IfFileExists "$INSTDIR\bin\tdm-native-host.exe" 0 +3
    ExecWait '"$INSTDIR\bin\tdm-native-host.exe" --register'
    Goto postinstall_done
  IfFileExists "$INSTDIR\resources\bin\tdm-native-host.exe" 0 +3
    ExecWait '"$INSTDIR\resources\bin\tdm-native-host.exe" --register'
    Goto postinstall_done
  IfFileExists "$INSTDIR\resources\tdm-native-host.exe" 0 postinstall_fallback
    ExecWait '"$INSTDIR\resources\tdm-native-host.exe" --register'
    Goto postinstall_done

postinstall_fallback:
  CreateDirectory "$APPDATA\tori-download-manager"
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.tori.download_manager" "" "$APPDATA\tori-download-manager\com.tori.download_manager.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.tori.download_manager" "" "$APPDATA\tori-download-manager\com.tori.download_manager.json"
  WriteRegStr HKCU "Software\Mozilla\NativeMessagingHosts\com.tori.download_manager" "" "$APPDATA\tori-download-manager\com.tori.download_manager.firefox.json"

postinstall_done:
  ; Terminate any stale TORI Desktop instance that may have been respawned by a
  ; browser Native Messaging host during installer extraction so the newly installed
  ; binary launches cleanly as the primary instance instead of hitting SECONDARY_INSTANCE.
  nsis_tauri_utils::FindProcessCurrentUser "tori-download-manager.exe"
  Pop $R0
  ${If} $R0 = 0
    nsis_tauri_utils::KillProcessCurrentUser "tori-download-manager.exe"
    Pop $R0
    Sleep 300
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Unregister Native Messaging Host cleanly
  IfFileExists "$INSTDIR\tdm-native-host.exe" 0 +3
    ExecWait '"$INSTDIR\tdm-native-host.exe" --unregister'
    Goto preuninstall_done
  IfFileExists "$INSTDIR\bin\tdm-native-host.exe" 0 +3
    ExecWait '"$INSTDIR\bin\tdm-native-host.exe" --unregister'
    Goto preuninstall_done
  IfFileExists "$INSTDIR\resources\bin\tdm-native-host.exe" 0 +3
    ExecWait '"$INSTDIR\resources\bin\tdm-native-host.exe" --unregister'
    Goto preuninstall_done
  IfFileExists "$INSTDIR\resources\tdm-native-host.exe" 0 preuninstall_done
    ExecWait '"$INSTDIR\resources\tdm-native-host.exe" --unregister'
preuninstall_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Clean up browser registry registrations
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.tori.download_manager"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.tori.download_manager"
  DeleteRegKey HKCU "Software\Mozilla\NativeMessagingHosts\com.tori.download_manager"
  
  ; Remove host manifests while preserving user downloads and SQLite database
  Delete "$APPDATA\tori-download-manager\com.tori.download_manager.json"
  Delete "$APPDATA\tori-download-manager\com.tori.download_manager.firefox.json"
!macroend


