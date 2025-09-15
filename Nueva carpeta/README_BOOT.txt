XMrig Boot SYSTEM Helper
===========================
Objetivo: lograr Huge Pages 100% en el dataset creando una tarea que arranca XMRig
AL INICIO DEL SISTEMA como SYSTEM (aun mas temprano que "al iniciar sesion").

Archivos:
- install_xmrig_boot_SYSTEM.cmd -> Crear la tarea (ejecutar como Administrador).
- remove_xmrig_boot_SYSTEM.cmd  -> Borrar la tarea.
- show_xmrig_boot_log.cmd       -> Ver el log generado por ese arranque.
- start_xmrig_manual_6threads.cmd -> Lanzador manual con 6 hilos para comparar.

Uso recomendado:
1) Asegurate que C:\XMRIG_MIN\ tiene xmrig.exe y config.json correctos (exe oficial y donate 0%).
2) Ejecuta 'install_xmrig_boot_SYSTEM.cmd' como Administrador -> aceptá reinicio.
3) Tras el reinicio, espera 30-60s y luego abre 'show_xmrig_boot_log.cmd'.
   - Busca 'randomx  allocated ... huge pages 100% 1168/1168'.
4) Si preferis no dejar la tarea, podés quitarla con 'remove_xmrig_boot_SYSTEM.cmd'.

Notas:
- Al correr como SYSTEM, no verás una ventana; todo va al log C:\XMRIG_MIN\xmrig_boot.log
- Si tu exe no es oficial, puede seguir forzando DONATE 1%. Reemplazalo por el oficial.
