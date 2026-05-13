!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif
!include "LogicLib.nsh"

!macro KillKnownProcessTree FILE
  StrCpy $R1 0
  ${Do}
    IntOp $R1 $R1 + 1
    ${nsProcess::FindProcess} "${FILE}" $R2
    ${If} $R2 != 0
      ${ExitDo}
    ${EndIf}

    nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /t /im "${FILE}" 1>nul 2>nul`
    nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /t /im "${FILE}" 1>nul 2>nul`

    Sleep 500
    ${If} $R1 >= 6
      ${ExitDo}
    ${EndIf}
  ${Loop}
!macroend

!macro ForceCloseWindSightMiniSimulator
  DetailPrint `Closing running "${PRODUCT_NAME}" automatically...`
  !insertmacro KillKnownProcessTree "${APP_EXECUTABLE_FILENAME}"
  !insertmacro KillKnownProcessTree "windsight-mini-simulator-backend.exe"
!macroend

!macro preInit
  !insertmacro ForceCloseWindSightMiniSimulator
!macroend

!macro customInit
  !insertmacro ForceCloseWindSightMiniSimulator
!macroend

!macro customCheckAppRunning
  !insertmacro ForceCloseWindSightMiniSimulator
!macroend

!macro customUnInit
  !insertmacro ForceCloseWindSightMiniSimulator
!macroend

!macro customUnInstall
  Delete "$DESKTOP\WindSight Manual Simulator.lnk"
!macroend
