@echo off
:: install_xmrig_boot_SYSTEM.cmd
:: Crea una tarea que ejecuta XMRig al INICIO DEL SISTEMA como SYSTEM (antes de tu logon)
:: para maximizar Huge Pages 100%% en el dataset.
:: Ejecutar ESTE .CMD como Administrador.
:: Supone que XMRIG esta en C:\XMRIG_MIN\ (xmrig.exe y config.json).

setlocal
set BASE=C:\XMRIG_MIN
set EXE=%BASE%\xmrig.exe
set CFG=%BASE%\config.json
set LOG=%BASE%\xmrig_boot.log

if not exist "%EXE%" (
  echo [ERROR] No existe %EXE%
  pause
  exit /b 1
)
if not exist "%CFG%" (
  echo [ERROR] No existe %CFG%
  pause
  exit /b 1
)

echo [*] Creando tarea 'XMRigBootSYSTEM' (al iniciar el sistema, usuario: SYSTEM)...
schtasks /Create /TN "XMRigBootSYSTEM" /SC ONSTART /RU "SYSTEM" /TR "cmd.exe /c ^"%EXE%^ --config=^"%CFG%^" --donate-level=0 --threads=6 --print-time=30 > ^"%LOG%^" 2>>&1" /F

if errorlevel 1 (
  echo [!] No se pudo crear la tarea.
  pause
  exit /b 1
)

echo [OK] Tarea creada.
echo [*] Al reiniciar, XMRig arrancara de fondo y escribira log en: %LOG%
echo.
echo [*] Reiniciar ahora? (S/N)
choice /c SN /n /m ""
if errorlevel 2 goto :no
shutdown /r /t 5
exit /b 0
:no
exit /b 0
