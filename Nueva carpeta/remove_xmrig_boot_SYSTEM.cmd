@echo off
:: remove_xmrig_boot_SYSTEM.cmd
:: Elimina la tarea XMRigBootSYSTEM
schtasks /Delete /TN "XMRigBootSYSTEM" /F
pause
