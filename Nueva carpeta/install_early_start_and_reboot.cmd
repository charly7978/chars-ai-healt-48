@echo off
:: install_early_start_and_reboot.cmd
:: Crea una tarea para iniciar XMRig apenas entres a tu sesión (logon), con máximos privilegios.
:: Requiere que este .CMD se ejecute desde la carpeta C:\XMRIG_MIN\
:: y que exista C:\XMRIG_MIN\start_xmrig.cmd

cd /d "%~dp0"
if /I not "%CD%"=="C:\XMRIG_MIN" (
  echo [!] Por favor copiate este archivo a C:\XMRIG_MIN\ y ejecutalo desde ahi.
  pause
  exit /b 1
)

if not exist "start_xmrig.cmd" (
  echo [ERROR] No esta start_xmrig.cmd en C:\XMRIG_MIN\
  dir /b
  pause
  exit /b 1
)

echo [*] Creando tarea programada 'XMRigEarly' (al iniciar sesion, privilegios maximos)...
SCHTASKS /Create /TN "XMRigEarly" /TR "\"C:\XMRIG_MIN\start_xmrig.cmd\"" /SC ONLOGON /RL HIGHEST /F

echo.
echo [OK] Tarea creada. Ahora vamos a REINICIAR el equipo para que, al entrar, XMRig arranque temprano con la RAM limpia.
echo     Guardá tu trabajo. El equipo se reiniciara en 10 segundos...
shutdown /r /t 10
pause
