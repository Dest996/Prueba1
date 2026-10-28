# AL DÍA

Versión 1.0 · Notas y proyectos

Dashboard compartido que convierte notas de trabajo en tareas, recordatorios, ideas y notas, agrupadas por proyecto. Puedes escribir texto, subir un audio o conectar tu número a un bot mediante la API oficial de WhatsApp Business de Meta.

## Usuarios y permisos por proyecto

Al abrir AL DÍA debes iniciar sesión. Tú como administrador conservas acceso a todas las notas, incluidos los elementos **Sin proyecto**, la configuración de IA y WhatsApp y la gestión de proyectos y usuarios.

- Si tu `.env` ya contiene `DASHBOARD_USER` y `DASHBOARD_PASSWORD`, se importan **una sola vez** como cuenta administradora. Entra con esas credenciales en el formulario de AL DÍA; ya no se utiliza el diálogo de autenticación Basic del navegador.
- Si no tenías contraseña, inicia AL DÍA en este equipo con `HOST=127.0.0.1`. La terminal muestra un código de instalación; úsalo en la pantalla **Crear administrador**, junto con tu usuario y una contraseña de al menos 10 caracteres. Ese código deja de funcionar cuando se crea el administrador y cambia si reinicias antes de completar la instalación. No hay una contraseña predeterminada ni registro público.
- Abre **Usuarios → Nuevo usuario**, escribe su nombre, usuario y contraseña inicial, y asigna los proyectos con **Puede editar**. Podrá ver, crear, editar, completar, mover y eliminar notas dentro de esos proyectos. También puedes elegir **Solo lectura** o **Sin acceso** para cada proyecto. Los proyectos nuevos comienzan sin asignaciones.
- **Editar acceso** permite cambiar asignaciones, desactivar/reactivar una cuenta y restablecer su contraseña. La revocación se aplica a la siguiente petición incluso en una sesión ya abierta; desactivar la cuenta o restablecer su contraseña cierra sus sesiones. Las cuentas desactivadas y sus notas se conservan.
- Cada persona puede cambiar su contraseña desde **Mi cuenta** y cerrar la sesión con **Salir**. Las sesiones vencen a las 12 horas. Comparte las credenciales iniciales por un canal privado; cada usuario puede cambiarlas al entrar.

Los permisos se verifican en el servidor. Los usuarios solo reciben sus proyectos y los elementos autorizados; los contadores y las búsquedas usan esos datos. Una nota que mezcla proyectos no autorizados muestra solo sus elementos visibles, **sin transcripción original**. Para editar, mover, eliminar o reclasificar una nota completa se requiere permiso de edición sobre **todos** sus elementos; las notas mixtas que no cumplan esto quedan en consulta y el administrador puede reorganizarlas. Las notas que capture un usuario se guardan en el proyecto asignado que seleccione, también si la IA no está configurada o falla. No puede moverlas a **Sin proyecto** ni a otro proyecto sin permiso de edición.

Renombrar un proyecto conserva sus asignaciones. Eliminarlo conserva sus notas sin proyecto, accesibles al administrador, y retira sus asignaciones. La conexión de WhatsApp sigue siendo la del administrador: no se añaden números de WhatsApp por usuario en esta versión.

Las contraseñas se guardan con sal aleatoria y scrypt; nunca se envían al navegador ni se guardan en texto plano en SQLite. Las sesiones usan cookies HttpOnly y SameSite=Strict, y las escrituras requieren un token CSRF. Los intentos de inicio de sesión están limitados por usuario e IP durante 15 minutos. Antes de añadir las tablas de usuarios a una base existente, AL DÍA crea una copia en `data/backups/before-users-…sqlite`. El resto de `.env`, las notas y las credenciales de los proveedores se conservan.

Para compartir AL DÍA entre equipos, todos deben conectarse a **la misma instancia del servidor** y su misma base de datos. Usa un dominio/proxy HTTPS para acceso remoto y `SESSION_COOKIE_SECURE=1` en tu `.env`; no expongas contraseñas mediante HTTP en Internet. El valor predeterminado permite probar en `http://localhost:3000`. No necesitas eliminar ni regenerar tu `.env` para instalar esta actualización.

### Recuperar la cuenta administradora

Si olvidas tu contraseña, detén AL DÍA, abre PowerShell en la carpeta habitual y ejecuta `npm run configurar:admin`. El asistente local pide una nueva contraseña oculta y su confirmación, guarda una copia previa en `data/backups/` y cierra las sesiones del administrador. Después ejecuta `npm start`. No cambia `.env`, las cuentas de los demás ni las notas. Cambiar `DASHBOARD_PASSWORD` después de la importación inicial **no** restablece una cuenta existente.

## Apariencia y vistas

AL DÍA usa una paleta azul sobre fondos oscuros, un check blanco dentro de un círculo azul como logo y ocupa el ancho disponible. El logo aparece en el inicio de sesión, la barra lateral y el icono de la pestaña. Los colores personalizados de tus proyectos se conservan. La pantalla inicial muestra **Solo pendientes** activado, con los elementos agrupados por proyecto en el orden de la barra lateral y **Sin proyecto** al final. Las notas con elementos de varios proyectos aparecen en cada grupo con sus elementos correspondientes; el contador cuenta cada nota una sola vez. Desactiva el filtro para consultar también los completados.

Selecciona **Lista** para filas de ancho completo o **Tarjetas** para bloques que se adaptan a la pantalla. La vista elegida se recuerda en ese navegador cuando el almacenamiento local está disponible. Al volver a abrir AL DÍA, el filtro de pendientes empieza activado.

**Nueva nota** abre el formulario de texto y audio; cerrarlo conserva el borrador mientras la página siga abierta. **Configuración**, disponible para el administrador, reúne el estado y la prueba del proveedor de IA (Gemini u OpenAI), la comprobación de WhatsApp y sus diagnósticos y errores de entrada. No se ejecutan pruebas de proveedores automáticamente.

## Organizar y personalizar

- **Proyectos:** elige un color al crearlos. El lápiz junto al nombre abre sus ajustes para cambiar nombre y color, subir o bajar su posición, o eliminarlo.
- **Notas:** abre el menú **⋯** de la nota. “Mover toda la nota a…” cambia de proyecto todos sus elementos. “Editar” permite cambiar el proyecto de un solo elemento.
- **Eliminar:** el menú **⋯** de cada nota tiene una acción “Eliminar nota”, que borra la nota completa después de confirmar. Cuando una nota contiene varios elementos, abre “Editar” en uno de ellos para usar “Quitar este elemento”. Esa acción conserva los demás elementos y la transcripción original. En notas con un solo elemento no se muestra un segundo control de borrado.
- **Eliminar proyectos:** conserva las notas y quita ese proyecto de sus elementos. Puedes encontrarlos en “Sin proyecto” y reasignarlos.
- **Colores y orden:** se guardan en SQLite y se conservan al reiniciar. Los colores aparecen junto al nombre en la barra lateral y en los elementos.

Al abrir una base de datos de una versión anterior por primera vez, AL DÍA crea una copia en `data/backups/` antes de incorporar los campos de color y orden. La migración conserva las transcripciones, categorías, fechas y estados de las notas. Las copias previas pueden contener notas que después hayas eliminado; no son una papelera accesible desde la interfaz. Los identificadores de entrega de WhatsApp se conservan sin el contenido de las notas eliminadas para impedir que una entrega duplicada las vuelva a crear.

### Actualizar esta versión en Windows

Usa la **misma carpeta de AL DÍA donde ya funcionan tus claves y notas**:

1. Detén únicamente AL DÍA con Ctrl+C. Puedes conservar el túnel de Cloudflare abierto.
2. Descarga y extrae el ZIP actualizado de la rama `hilo-inicial` en una carpeta temporal.
3. Copia los archivos del ZIP a tu carpeta habitual conservando `.env` y `data`. Para la actualización desde la última versión reemplaza `server.js`, `ai.js`, `gemini.js`, `whatsapp.js`, `package.json`, `package-lock.json`, `public/index.html`, `public/app.js`, `public/style.css`, `scripts/configure-admin.js`, `scripts/configure-openai.js`, `scripts/configure-whatsapp.js` y `scripts/subscribe-whatsapp.js`. Añade **`public/logo.svg`**. Copia `README.md`, `docs/whatsapp-windows.md` y `test/ai.test.js` para actualizar documentación y pruebas. Si vienes de una versión anterior a usuarios, copia también `auth.js` y la carpeta `test` completa. No reemplaces tu `.env` con la plantilla.
4. Abre PowerShell en tu carpeta habitual y ejecuta `npm start`.
5. Actualiza el dashboard con Ctrl+F5. Verás **AL DÍA** y el nuevo logo azul. Tus cuentas, sesiones y notas seguirán disponibles; los permisos se administran desde **Usuarios**.

En PowerShell, desde tu carpeta habitual y con AL DÍA detenido, indica la ruta del ZIP ya extraído (la carpeta que contiene `package.json`):

```powershell
$origen = 'C:\ruta\temporal\Prueba1-hilo-inicial'
$archivos = @(
    'server.js', 'ai.js', 'gemini.js', 'whatsapp.js', 'auth.js',
    'package.json', 'package-lock.json',
    'public\index.html', 'public\app.js', 'public\style.css', 'public\logo.svg',
    'scripts\configure-admin.js', 'scripts\configure-openai.js',
    'scripts\configure-whatsapp.js', 'scripts\subscribe-whatsapp.js'
)
foreach ($archivo in $archivos) {
    Copy-Item -LiteralPath (Join-Path $origen $archivo) -Destination (Join-Path (Get-Location) $archivo) -Force
}
npm start
```

Estos comandos actualizan solo los archivos de la aplicación indicados; no sobrescriben `.env` ni `data`.

La copia anterior a la migración se genera automáticamente si hay datos existentes. Para conservar otras copias de seguridad, copia `data` con AL DÍA detenido. No necesitas generar claves nuevas ni volver a suscribir WhatsApp para esta actualización.

## Ejecutar

Necesitas Node.js 24 o superior. No hay dependencias externas de npm: el servidor usa HTTP, SQLite y `fetch` incluidos en Node.

```sh
cd /workspace/Prueba1
# Solo la primera vez; no sobrescribas una configuración existente.
cp -n .env.example .env
npm start
```

El servidor escucha en el puerto 3000 y únicamente en loopback por defecto. Los datos se crean en `data/notes.sqlite`; no se incluyen en Git. Para ejecutar las pruebas: `npm test`. Las pruebas usan bases temporales independientes.

1. Crea tus proyectos en el panel lateral.
2. Pulsa **Nueva nota**, escribe y guarda, o sube un audio de hasta 20 MB con OpenAI o 14 MB con Gemini.
3. Filtra por proyecto o tipo y corrige los elementos con **Editar**.
4. Marca los elementos completados. Consulta la transcripción con **Ver original**.

Sin una clave para el proveedor seleccionado, las notas de texto se guardan como notas **Por clasificar** y se pueden organizar manualmente. Los audios requieren la clave para transcribir. Al activar IA, **Clasificar con IA** permite procesar de nuevo las notas guardadas; esta acción reemplaza sus elementos y correcciones.

## Usar Gemini con cuota gratuita en Windows

AL DÍA permite elegir **Gemini** en lugar de OpenAI tanto para transcribir como para clasificar. La cuota gratuita depende del modelo, la región y el proyecto de Google. Comprueba las condiciones y disponibilidad vigentes en [Google AI Studio](https://aistudio.google.com/) y [precios de Gemini](https://ai.google.dev/gemini-api/docs/pricing). No se garantiza uso ilimitado ni que tu cuenta disponga de un modelo específico gratis. En el nivel gratuito, Google puede usar las entradas y salidas para mejorar sus productos: evita información laboral sensible y revisa sus condiciones antes de enviar audios.

1. Si tienes una versión anterior, detén AL DÍA con Ctrl+C y descarga el ZIP actualizado de la rama `hilo-inicial`. Extrae en una carpeta temporal y actualiza tu carpeta habitual siguiendo **Actualizar esta versión en Windows**; conserva `.env` y `data`.
2. Crea una clave desde https://aistudio.google.com/apikey. Para usar solo la cuota gratuita, comprueba que tu proyecto tiene esa modalidad disponible y no habilites facturación. Si ya tiene facturación, puede generar cargos según el modelo y el uso; AL DÍA no controla el saldo ni tu modalidad de Google.
3. Abre PowerShell en la carpeta que contiene `package.json` y ejecuta:

   ```bat
   npm run configurar -- gemini
   ```

4. Pega la clave en el asistente y pulsa Enter. Se guardan `GEMINI_API_KEY` y `AI_PROVIDER=gemini` en `.env`, sin mostrar la clave ni subirla a GitHub. La clave de OpenAI anterior se conserva pero no se usa con este proveedor activo.
5. Ejecuta `npm start`, abre `localhost:3000` en Windows y abre **Configuración → Comprobar IA**. El dashboard debe indicar **Gemini configurado**. La prueba consume una solicitud del cupo.
6. Crea un proyecto y prueba una nota de texto. Después sube un audio corto para comprobar transcripción y clasificación. Cada audio normalmente consume dos solicitudes: una para transcribir y otra para clasificar.

Con `GEMINI_MODEL` vacío, AL DÍA consulta el catálogo de tu clave y elige un modelo Flash Lite estable reciente, o Flash si no encuentra Lite. Descubrir un modelo no acredita que tu cuenta tenga cuota gratuita para él: compruébalo en AI Studio. Puedes fijar otro modelo compatible con audio y salida JSON estructurada mediante `GEMINI_MODEL` en `.env` y reiniciar AL DÍA. No se activa facturación ni se consulta el saldo desde la app. El envío directo de audio tiene un límite conservador de **14 MB** para permitir su codificación base64 dentro del límite de la petición. Usa grabaciones breves; si se agota la cuota, la app muestra el error y no cambia automáticamente a OpenAI ni a otro proveedor de pago.

El servidor necesita acceso HTTPS a `generativelanguage.googleapis.com`. No envía datos a OpenAI cuando `AI_PROVIDER=gemini`. La clave permanece en el servidor; nunca se envía al navegador. Para volver a OpenAI, ejecuta `npm run configurar -- openai` y reinicia.

## Activar OpenAI en Windows

Si ya tienes AL DÍA instalado, sigue **Actualizar esta versión en Windows** para actualizar la misma carpeta conservando `.env` y `data`.

1. Abre https://platform.openai.com/api-keys y crea una clave para tu proyecto de OpenAI. Guárdala de forma privada; no la pegues en chats ni en GitHub.
2. Revisa la facturación de API en https://platform.openai.com/settings/organization/billing/overview y configura un saldo y límites apropiados. La API tiene cobro por uso; una suscripción a ChatGPT no incluye estos consumos. Los presupuestos pueden ser alertas, no un corte garantizado del gasto.
3. En el Explorador de Windows abre la carpeta que contiene `package.json`, escribe `powershell` en la barra de la ruta y pulsa Enter.
4. Ejecuta:

   ```bat
   npm run configurar
   ```

5. Pega la clave y pulsa Enter. El texto permanece oculto. El asistente guarda la clave en `.env`, ignorado por Git, y conserva las demás variables. No envía la clave a ningún servicio durante la configuración.
6. Ejecuta `npm start` y abre `localhost:3000` en tu navegador de Windows.
7. Abre **Configuración → Comprobar IA**. Se envía una pequeña nota de ejemplo al modelo de clasificación (consume API), sin guardar una nota en tu bandeja. Una respuesta correcta comprueba clasificación; no acredita todavía el modelo de transcripción.
8. Crea un proyecto llamado **Norte** y guarda: “Para Norte, enviar el presupuesto el viernes. También tengo la idea de ofrecer mantenimiento mensual”. Deben aparecer elementos separados de tarea e idea; comprueba y corrige sus fechas si hace falta.
9. Usa **Subir audio** con una grabación breve para comprobar la transcripción y la clasificación completas. Revisa el original y los elementos obtenidos. El audio y su texto se envían a OpenAI al usar esta función.

Si aparece un error, AL DÍA distingue una clave rechazada, cuota insuficiente, límites temporales de solicitudes y problemas de red. Las notas cuyo texto ya se obtuvo se conservan aunque falle la clasificación. Si cambias la clave o los modelos, reinicia AL DÍA. La clave nunca se envía al navegador; el dashboard llama a tu servidor y este llama a OpenAI.

### Si OpenAI responde con HTTP 429

HTTP 429 puede indicar falta de cuota/saldo o un límite temporal de solicitudes/tokens. No demuestra por sí solo que hayas enviado muchos mensajes. AL DÍA distingue los códigos de cuota y límites conocidos y, si no recibe un diagnóstico reconocido, lo indica sin asumir la causa.

1. Comprueba el saldo de API en https://platform.openai.com/settings/organization/billing/overview. Una suscripción a ChatGPT no aporta saldo de API.
2. Revisa que estás viendo la organización y el proyecto a los que pertenece la clave usada en AL DÍA, y consulta sus límites de uso.
3. Si acabas de activar la facturación, espera a que esté disponible y vuelve a probar **Comprobar IA** una vez. No es necesario descargar otra versión para que se aplique un cambio de saldo.
4. Si el error confirma un límite temporal, espera y revisa los límites del proyecto si persiste. Si cambias la clave, ejecuta `npm run configurar` y reinicia AL DÍA.

## IA

Para OpenAI, configura `OPENAI_API_KEY` mediante el gestor seguro del entorno o tu `.env` local, nunca en Git ni en el chat. La cuenta debe tener acceso a los modelos y facturación disponible. Los modelos predeterminados son `gpt-4o-mini-transcribe` para voz y `gpt-4.1-mini` para clasificación; se pueden cambiar en `.env`.

La IA recibe la transcripción, la lista de proyectos existentes, la fecha de recepción y la zona horaria (`America/Santiago` por defecto). Divide un audio en varios elementos y usa únicamente proyectos existentes; lo ambiguo queda sin proyecto o sin fecha para corregirlo manualmente. Las fechas se guardan como días, no como alarmas con hora.

Si falla la clasificación, se conserva el texto sin clasificar. Si falla la transcripción de una carga directa, vuelve a subir el archivo; en WhatsApp el trabajo queda en error y se puede reintentar desde el dashboard.

## Conectar WhatsApp (requiere configuración externa)

Para empezar desde cero en Windows, sigue la [guía paso a paso de WhatsApp](docs/whatsapp-windows.md). Incluye número de pruebas de Meta, asistente `npm run configurar:whatsapp`, comprobación de acceso y un túnel HTTPS que expone solo el receptor de mensajes.

El adaptador está implementado, pero la conexión real requiere una app de Meta con WhatsApp Business, un número emisor del bot y un token con acceso a los medios. Puede usarse el número de pruebas de Meta durante el desarrollo. Tu número personal es el remitente permitido, no el número del bot.

1. Configura `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, un `WHATSAPP_VERIFY_TOKEN` aleatorio y `WHATSAPP_ALLOWED_FROM` con tu número en formato internacional sin `+`.
2. Expón el servidor mediante un proxy HTTPS o un despliegue que termine TLS. Configura `HOST=0.0.0.0` si lo requiere tu plataforma y **antes** configura `DASHBOARD_USER` y una contraseña larga en `DASHBOARD_PASSWORD`. Crea primero el administrador en localhost, usa HTTPS para el dashboard y activa `SESSION_COOKIE_SECURE=1` al compartirlo por HTTPS. No publiques el dashboard con HTTP sin cifrar.
3. En Meta, registra el endpoint público HTTPS `/webhook` con el mismo token de verificación y suscribe el campo `messages` de WhatsApp Business.
4. Envía un audio desde el número permitido y comprueba su transcripción y clasificación en el dashboard. Los errores de procesamiento se muestran en **Entrada de WhatsApp**.

El endpoint valida las firmas HMAC de Meta, confirma recepción antes de procesar, persiste los trabajos y evita duplicados por identificador de mensaje. Solo acepta texto y audio del número permitido; si falta `WHATSAPP_ALLOWED_FROM`, no ingiere mensajes. Los trabajos que estaban procesándose se recuperan al reiniciar; los errores requieren reintento manual. No se envían respuestas, confirmaciones ni recordatorios por WhatsApp en esta versión.

Para la conexión externa se necesitan destinos HTTPS: `api.openai.com` (OpenAI) o `generativelanguage.googleapis.com` (Gemini), además de `graph.facebook.com` y los destinos de medios admitidos `lookaside.fbsbx.com` / `lookaside.facebook.com`. La recepción del webhook también necesita un endpoint HTTPS público; una lista de destinos salientes no proporciona ese endpoint. El adaptador usa Graph API v23.0 por defecto, configurable con `WHATSAPP_GRAPH_VERSION`. El asistente configura `WHATSAPP_PHONE_NUMBER_ID` para filtrar el número del bot y un receptor separado en `WHATSAPP_WEBHOOK_PORT` para el túnel de pruebas.

## Datos y límites

- Varios usuarios en una única instancia y un único proceso de servidor. No implementa organizaciones independientes ni sincronización entre distintas carpetas o servidores.
- SQLite conserva originales, elementos y la cola de mensajes. Haz copias de `data/` con el servidor detenido. Protege el disco: SQLite no está cifrado por esta app.
- Los audios se procesan en memoria y no se conservan en disco; para reprocesarlos directamente hay que subirlos otra vez. Meta puede limitar la disponibilidad de sus medios.
- Al usar IA, el audio y el texto se envían al proveedor seleccionado (OpenAI o Gemini); al usar WhatsApp, también interviene Meta. Revisa qué información laboral puedes enviar a estos proveedores.
- Los recordatorios solo aparecen en el dashboard: no hay notificaciones, alarmas ni envío programado.
- El dashboard muestra fechas con el formato local del navegador; la interpretación por IA usa `TIMEZONE`.
- La eliminación requiere confirmación y no tiene opción de deshacer. No hay sincronización externa ni papelera en esta versión.

## Validación

`npm test` comprueba sesiones, CSRF, roles, aislamiento entre proyectos, transcripciones de notas mixtas, revocación, recuperación de administrador, expiración y contraseñas, además de la migración de bases antiguas con copia de seguridad, renombrado y eliminación de proyectos sin perder notas, colores, orden, reasignación, borrado con deduplicación, y la descarga e integridad de medios, el receptor público separado y un audio firmado con IA simulada, además de autenticación, bloqueo de escrituras desde otro origen, persistencia tras reinicio, edición de varios elementos, validación de fechas, verificación y firma del webhook, restricción del remitente y deduplicación. Estas pruebas no consumen servicios externos ni acreditan una conexión real a Meta/OpenAI. La recepción y transcripción reales requieren completar la configuración y realizar una prueba con un audio propio.
