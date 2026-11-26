# GestOK Control V30 — Alta administrativa de Traslados

Rama `feature/traslados-admin-v30` de `gestokwebcontrolpaneladmin`. Web Control V51.50 sigue siendo la referencia del sistema principal. Los paneles de conductor y pasajero se implementarán en V51.51 sobre el mismo `index.html` y dominio `gestokwebcontrol.online`.

## Registro de la actualización · 24 de noviembre de 2026

- V40 compara la definición completa y la validación del CHECK de sectores con el esquema auditado en PostgreSQL 17. Usa un máximo de 3 segundos de espera por bloqueo y 30 segundos por sentencia. Comprueba columnas, tipos, defaults, restricciones y triggers de una configuración preexistente. Una incompatibilidad aborta toda la transacción.
- Cada organización de Traslados recibe un UUID `public_code` único y permanente durante su existencia. Un trigger protege el UUID y su vínculo con la organización. V40 exige `requests_enabled = false`, con RLS y sin permisos de navegador sobre `transport_settings`.
- La Edge Function verifica la sesión y `developer_admins`. El RPC de V40, accesible solo para `service_role` entre los roles de API, confirma en una transacción la organización, la membresía, la suscripción, el pago inicial cuando corresponde, el aviso y la configuración obligatoria. Ante un rollback SQL confirmado, la Edge Function compensa solo el usuario de Auth creado por esa misma solicitud. Si el resultado es incierto, verifica la membresía y devuelve una referencia cuando requiere revisión.
- El administrador ahora llama a `admin-update-client-credentials-5-`. La versión desplegada 6 recibe `organizationId`, `username` y `password` opcional, y devuelve `ok`, `username` y `passwordChanged`. Esta verificación fue por lectura de su fuente. La función desplegada elige el miembro más antiguo con acceso y ejecuta los cambios en Auth y en la organización por separado. Revisitá ese comportamiento antes de agregar múltiples credenciales por empresa.
- La auditoría confirmó los permisos de `service_role` sobre las tablas usadas por el RPC. El registro de migraciones estándar de Supabase no estaba presente. Se mantuvo la secuencia de instalación de una sola migración, con registro explícito de su aplicación.
- Pruebas ejecutadas con Node.js 24 y PostgreSQL 17.5 en memoria. Se usaron organizaciones y credenciales ficticias. Pendiente la prueba integral en un Supabase aislado con su gateway, Auth y el navegador. Producción se consultó en modo de solo lectura.

## Auditoría separada de prensa y tesoreria

Las dos tablas del esquema `public` tienen RLS deshabilitada. El catálogo confirmó estos permisos efectivos:

| Rol | SELECT | INSERT | UPDATE | DELETE | TRUNCATE |
|---|---|---|---|---|---|
| `anon` | Sí | Sí | Sí | Sí | No |
| `authenticated` | Sí | Sí | Sí | Sí | Sí |
| `service_role` | Sí | Sí | Sí | Sí | Sí |

No se encontraron referencias directas en las llamadas de los repositorios, en el texto de funciones SQL de `public` ni en las dependencias de vistas visibles para la sesión auditora. Eso deja pendiente identificar posibles integraciones externas antes de ajustar permisos. Si el esquema y estas tablas están expuestos en la Data API, los permisos de los roles de navegador permiten operaciones sin filtros por fila. No se leyeron registros de estas tablas ni se modificaron permisos o políticas.

## Pruebas locales

Ejecutar desde el repositorio del administrador. PGlite se instala en una carpeta temporal y usa una base en memoria.

```powershell
$testDir = Join-Path ([IO.Path]::GetTempPath()) ('gestok-v40-tests-' + [guid]::NewGuid().ToString('N'))
npm.cmd install --prefix $testDir --no-audit --no-fund @electric-sql/pglite@0.3.15
$env:GESTOK_PGLITE_MODULE = Join-Path $testDir 'node_modules/@electric-sql/pglite/dist/index.js'
node --test tests/traslados-v30.test.mjs
```

### Integración con Supabase local

El entorno de integración requiere Docker Desktop iniciado con el motor de Linux. En Windows, habilitar WSL 2 con `wsl --install --no-distribution` desde PowerShell como administrador, reiniciar si Windows lo solicita, y luego instalar Docker Desktop con el backend WSL 2. Confirmar que `docker version` muestra cliente y servidor.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/start-traslados-local.ps1
```

El lanzador genera un proyecto temporal con su propia configuración y dos migraciones, el esquema ficticio y V40. Usa Auth, PostgREST y Edge Runtime reales del stack local. Comparte las claves generadas solo con el proceso de prueba. El cliente exige una URL de loopback y un marcador del esquema ficticio antes de crear cuentas. Con `-PrepareOnly` solo se preparan los archivos. Ejecutar el comando con los puertos locales predeterminados de Supabase disponibles.

La suite crea diez cuentas ficticias, una paga y una de prueba por sector. Verifica inicio de sesión, membresías, suscripciones, pago inicial, alias, aislamiento por organización y rechazo del alta a usuarios no autorizados. También comprueba el UUID y la configuración privada de Traslados.

**Estado de integración.** En la estación auditada faltan Docker Desktop y WSL. El esquema ficticio generado y V40 se aplicaron correctamente sobre PostgreSQL 17.5 en memoria y las 14 pruebas de regresión aprobaron. La aplicación de V40 al stack con Docker y las pruebas reales con Auth y Edge Runtime quedan pendientes.

Antes de solicitar publicación, validar en el entorno aislado estos flujos con datos de prueba:

| Caso | Verificar |
|---|---|
| Los cinco sectores | Alta paga y prueba gratuita, inicio con usuario exacto y alias, organización y membresía, vencimiento, pago inicial, notificación, edición de credenciales y rechazo sin autorización. |
| Comercio · SCR | Los pedidos conservan señas, medios de pago, cobro al finalizar y registro en los informes. |
| Comercio · Carlos | Compras, proveedores, movimientos y GestOK AI con rol administrador. |
| Barbería | Servicios iniciales, turnos y enlace de reservas Biondi. |
| Estacionamiento | Tarifas, sesión por patente, ticket QR, cierre y cobro. |
| Restaurante | Diez mesas iniciales, carta, pedidos por QR y estados. |
| Traslados | UUID único e inmutable tras renombrar o cambiar credenciales, RLS sin acceso de navegador y solicitudes públicas desactivadas. |
| Fallos y aislamiento | Rechazo de alias duplicado, caída de una escritura, respuesta perdida, reintento e imposibilidad de acceder a otra empresa. |

## Secuencia de instalación

### Validación compartida con Web Control V51.53

El lanzador acepta el repositorio de Web Control y agrega V41 y V42 después de V40 en un directorio temporal. La suite comprueba el enlace inicialmente deshabilitado, activa solo las cuentas ficticias que acaba de crear y prueba dos conductores y dos comprobantes independientes, Realtime, reintentos, reconexión, cierre, balance e invalidación del token de renovación. Esta variante requiere ambas ramas de desarrollo disponibles localmente.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/start-traslados-local.ps1 -WebControlPath ..\gestokwebcontroler
```

Para preparar los archivos sin arrancar Supabase, agregar `-PrepareOnly`. El 25 de noviembre de 2026 se comprobó la preparación local y pasaron las 14 regresiones de V30. La ejecución con Auth, gateway y WebSocket del stack sigue pendiente por falta de Docker Desktop y WSL. Ver el informe de la rama de Web Control antes de autorizar producción.

### Pasos de instalación

1. Confirmar que el código de la rama y los resultados de las pruebas están aprobados. Repetir la verificación del CHECK, permisos, tabla de configuración y versiones desplegadas en el destino. Guardar una copia del esquema y un respaldo verificable. Descargar la versión desplegada de `admin-create-client` para recuperación y comprobar que no haya cambios posteriores que deban conservarse.
2. En el entorno aislado, ejecutar una sola vez el archivo `supabase/migrations/20261124000100_traslados_admin_v40.sql` completo como usuario de migración. Si el bloqueo expira o una comprobación falla, verificar que la transacción se revirtió e investigar la causa antes de repetir. Confirmar el CHECK de cinco sectores, el RPC restringido, la unicidad del UUID y el bloqueo de solicitudes. Usar esta misma secuencia en producción únicamente con autorización de Carlos y registrar destino, archivo, revisión, fecha y resultado.
3. Desplegar únicamente `admin-create-client` al destino validado, con verificación JWT habilitada. Desde el administrador y con `$destino` asignado a la referencia que se verificó, ejecutar `npx.cmd supabase@3.4.0 functions deploy admin-create-client --remote=$destino --use-api` y comprobar el estado con `npx.cmd supabase@3.4.0 functions list --remote=$destino`. Probar el alta en el entorno aislado. El despliegue de producción requiere autorización. Verificar que el destino también tenga la función compatible de edición de credenciales.
4. Publicar el HTML del administrador después de verificar la Edge Function y la regresión en el entorno aislado. Mantener las solicitudes públicas desactivadas hasta una migración específica de Web Control V51.51 aprobada. Las altas reales de producción requieren autorización.
5. Si falla el despliegue posterior a V40, recuperar el HTML y la Edge Function previamente respaldados. Conservar la estructura y los datos de V40. Si un alta queda sin confirmar, usar la referencia del error para revisar la organización, la membresía y el usuario de Auth antes de reintentar.
