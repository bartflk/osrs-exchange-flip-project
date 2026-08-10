@echo off
REM Project Flashwave -- one-click launcher.
REM
REM This exists as a .bat rather than a bare .ps1 because Windows will not run a PowerShell
REM script on double-click by default (the execution policy blocks it, and the shell's default
REM action for .ps1 is "open in Notepad"). Launching powershell.exe with -ExecutionPolicy Bypass
REM from a .bat is what makes this genuinely one click, without changing any machine-wide setting.
REM
REM The actual logic lives in the project folder (start.ps1) so it stays version-controlled.

set "PROJECT=%USERPROFILE%\Desktop\osrs exchange flip project"

if not exist "%PROJECT%\start.ps1" (
    echo.
    echo   Could not find the project at:
    echo     %PROJECT%
    echo.
    echo   If you moved or renamed the folder, edit the PROJECT line in this file
    echo   ^(right-click ^> Edit^) to point at the new location.
    echo.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT%\start.ps1"
