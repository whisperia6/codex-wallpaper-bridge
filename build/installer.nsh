!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      DetailPrint "Requesting Lumina to exit gracefully..."
      nsExec::Exec `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-running-instance`
      Pop $R2
      StrCpy $R3 0
      ${DoWhile} $R3 < 16
        Sleep 500
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 != 0
          ${ExitDo}
        ${endIf}
        IntOp $R3 $R3 + 1
      ${Loop}
    ${endIf}
  ${endIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend
