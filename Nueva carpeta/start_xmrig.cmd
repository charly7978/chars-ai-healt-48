@echo off
REM start_xmrig.cmd - pack minimo (3 archivos): xmrig.exe, config.json, start_xmrig.cmd
REM Ejecucion:
REM  - Doble click (se auto-eleva a Administrador).
REM  - Usa el config.json de esta carpeta.
REM  - Si queres fijar hilos, editá la variable THREADS abajo (dejar vacia para auto).

setlocal ENABLEDELAYEDEXPANSION

REM === OPCIONAL: fija cantidad de hilos ===
REM set THREADS=6
set THREADS=

REM Re-ejecutar como Admin si hace falta
net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo [*] Elevando privilegios de Administrador...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"

if not exist "xmrig.exe" (
  echo [ERROR] No se encontro xmrig.exe en %cd%
  dir /b
  echo.
  pause
  exit /b 1
)

REM Sugerir Alto Rendimiento (si existe)
powercfg -setactive SCHEME_MAX >nul 2>&1

echo [*] Iniciando XMRig (donate=0%%) desde: %cd%
if defined THREADS (
  echo [*] Forzando threads=%THREADS%
  set THREADS_ARG=--threads=%THREADS%
) else (
  set THREADS_ARG=
)

echo.
xmrig.exe --config="%cd%\config.json" --donate-level=0 %THREADS_ARG%
echo.
echo [*] XMRig termino con codigo %errorlevel%
echo [i] Si 'Huge Pages' aparece 0%%, reinicia Windows y ejecuta este script apenas inicia (sin abrir otros programas).
pause
