!macro NSIS_HOOK_PREINSTALL
  ; Pre-install hook
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


