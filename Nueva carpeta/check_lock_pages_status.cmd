@echo off
:: check_lock_pages_status.cmd
:: Verifica via secedit si 'SeLockMemoryPrivilege' incluye tu usuario y/o Administrators (sin PowerShell).

setlocal
set CFG=%TEMP%\lpim.inf
echo [*] Exportando politica local a: %CFG%
secedit /export /cfg "%CFG%" >nul 2>&1
if errorlevel 1 (
  echo [!] No se pudo exportar la politica con 'secedit'. En Windows Home puede faltar.
  echo     Si XMRig muestra 'HUGE PAGES permission granted' y lográs 'huge pages 100%%' tras reiniciar, esta parte esta bien.
  pause
  exit /b 0
)

echo.
echo [*] Linea encontrada (si existe):
for /f "usebackq tokens=*" %%L in (`findstr /R /C:"^SeLockMemoryPrivilege\s*=" "%CFG%"`) do (
  echo     %%L
  set LINE=%%L
)

echo.
whoami
echo [*] Grupos del usuario actual (buscando Administrators):
whoami /groups | findstr /I Administrators

echo.
echo [i] Si ves S-1-5-32-544 en la linea 'SeLockMemoryPrivilege', es el grupo BUILTIN\Administrators.
echo [i] Si tu usuario pertenece a Administrators, hereda el privilegio.
pause
