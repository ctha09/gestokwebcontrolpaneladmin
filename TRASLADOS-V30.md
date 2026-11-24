# GestOK Control V30 — Traslados

Cambios en rama de desarrollo. No publicar antes de verificar Supabase.

1. Respaldar la base de datos. Verificar restricciones de organizations y versión desplegada de admin-create-client.
2. Ejecutar únicamente la migración V40 después de revisarla. No ejecutar nuevamente migraciones antiguas.
3. Comparar la Edge Function incluida (basada en V17 archivada) con la actualmente desplegada; conservar cualquier cambio posterior antes de desplegar. Mantener la verificación de developer_admins y las claves de servicio exclusivamente en Supabase.
4. Probar creación de una cuenta Traslados y verificar organización, miembro, suscripción y transport_settings (requests_enabled=false). Comprobar también los cuatro sectores existentes y el rechazo de usuarios sin autorización.
5. Publicar el HTML tras superar las pruebas. El panel del conductor y el cliente aún no están implementados. No activar pedidos públicos.

No se ha ejecutado SQL ni desplegado la función. No hay credenciales privadas en estos cambios.
