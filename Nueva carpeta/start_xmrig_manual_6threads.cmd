@echo off
:: start_xmrig_manual_6threads.cmd
:: Arranque manual con 6 hilos para comparar rendimiento vs 8.
cd /d "%~dp0"
if /I not "%CD%"=="C:\XMRIG_MIN" (
  echo [!] Ejecuta esto desde C:\XMRIG_MIN\
  pause
  exit /b 1
)

net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo [*] Elevando a Administrador...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powercfg -setactive SCHEME_MAX >nul 2>&1
echo [*] Iniciando XMRig 6 hilos (donate=0%%)
xmrig.exe --config="C:\XMRIG_MIN\config.json" --donate-level=0 --threads=6 --print-time=30
echo.
echo [*] Codigo salida: %errorlevel%
pause
