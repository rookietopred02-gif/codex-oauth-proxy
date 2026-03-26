!macro customUnInstallSection
  Section /o "un.Remove current user's app data (%APPDATA%\codex-pro-max)"
    ${ifNot} ${isUpdated}
      DetailPrint "Removing current user's app data from $APPDATA\codex-pro-max"
      SetShellVarContext current
      RMDir /r "$APPDATA\codex-pro-max"
    ${endIf}
  SectionEnd
!macroend
