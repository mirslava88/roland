!macro customInstall
  DetailPrint "Registering PDM Virtual Camera media source"
  nsExec::ExecToLog '"$INSTDIR\resources\virtual-camera\PDMVirtualCameraHost.exe" --install-source "$INSTDIR\resources\virtual-camera\PDMVirtualCameraSource.dll"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "PDM Virtual Camera registration returned $0"
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing PDM Virtual Camera media source"
  nsExec::ExecToLog '"$INSTDIR\resources\virtual-camera\PDMVirtualCameraHost.exe" --uninstall-source'
  Pop $0
!macroend
