!macro customInstall
  DetailPrint "Registering PDM Virtual Camera media source"
  nsExec::ExecToLog '"$INSTDIR\resources\virtual-camera\PDMVirtualCameraHost.exe" --install-source "$INSTDIR\resources\virtual-camera\PDMVirtualCameraSource.dll" "${APP_ID}"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "PDM Virtual Camera registration failed with code $0"
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "Не удалось установить виртуальную камеру PDM (код $0). Установка PDM прервана. Закройте приложения, использующие камеру, и повторите установку."
    ${EndIf}
    Abort "PDM Virtual Camera registration failed with code $0"
  ${EndIf}
  nsExec::ExecToLog '"$INSTDIR\resources\virtual-camera\PDMVirtualCameraHost.exe" --source-registered'
  Pop $0
  ${If} $0 != 0
    DetailPrint "PDM Virtual Camera registration verification failed with code $0"
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "Windows не подтвердила установку виртуальной камеры PDM (код $0). Установка PDM прервана."
    ${EndIf}
    Abort "PDM Virtual Camera registration verification failed with code $0"
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing PDM Virtual Camera media source"
  nsExec::ExecToLog '"$INSTDIR\resources\virtual-camera\PDMVirtualCameraHost.exe" --uninstall-source "${APP_ID}"'
  Pop $0
!macroend
