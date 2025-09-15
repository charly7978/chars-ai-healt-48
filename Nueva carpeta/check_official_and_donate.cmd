@echo off
:: check_official_and_donate.cmd
:: Muestra el SHA256 del xmrig.exe y algunas pistas de donacion soportadas por el binario.
cd /d "%~dp0"
if not exist "xmrig.exe" (
  echo [ERROR] No esta xmrig.exe en %CD%
  dir /b
  pause
  exit /b 1
)

echo [*] Hash SHA256 de xmrig.exe (comparar con el publicado en la release oficial):
certutil -hashfile xmrig.exe SHA256

echo.
echo [*] Ayuda de xmrig para opciones donate (si el binario las soporta):
xmrig.exe --help | findstr /I donate

echo.
echo [*] Version detallada:
xmrig.exe --version
pause
