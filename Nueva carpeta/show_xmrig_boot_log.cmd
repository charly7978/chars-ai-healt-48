@echo off
:: show_xmrig_boot_log.cmd
:: Muestra las ultimas 80 lineas del log del arranque como SYSTEM
set LOG=C:\XMRIG_MIN\xmrig_boot.log
if not exist "%LOG%" (
  echo [!] No existe %LOG%
  pause
  exit /b 1
)
type "%LOG%" | more
echo.
echo ----- ULTIMAS 80 LINEAS -----
powershell -NoProfile -Command "Get-Content -Path '%LOG%' -Tail 80"
pause
