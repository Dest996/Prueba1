# Hilo — memoria personal de trabajo

Primera versión de un dashboard personal que convierte notas de trabajo en tareas, recordatorios, ideas y notas, agrupadas por proyecto. Puedes escribir texto, subir un audio o conectar tu número a un bot mediante la API oficial de WhatsApp Business de Meta.

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
2. Escribe una nota y guárdala, o sube un audio de hasta 20 MB.
3. Filtra por proyecto o tipo y corrige los elementos con **Editar**.
4. Marca los elementos completados. Consulta la transcripción con **Ver original**.

Sin `OPENAI_API_KEY`, las notas de texto se guardan como notas **Por clasificar** y se pueden organizar manualmente. Los audios requieren la clave para transcribir. Al activar IA, **Clasificar con IA** permite procesar de nuevo las notas guardadas; esta acción reemplaza sus elementos y correcciones.

## IA

Configura `OPENAI_API_KEY` mediante el gestor seguro del entorno o tu `.env` local, nunca en Git ni en el chat. La cuenta debe tener acceso a los modelos y facturación disponible. Los modelos predeterminados son `gpt-4o-mini-transcribe` para voz y `gpt-4.1-mini` para clasificación; se pueden cambiar en `.env`.

La IA recibe la transcripción, la lista de proyectos existentes, la fecha de recepción y la zona horaria (`America/Santiago` por defecto). Divide un audio en varios elementos y usa únicamente proyectos existentes; lo ambiguo queda sin proyecto o sin fecha para corregirlo manualmente. Las fechas se guardan como días, no como alarmas con hora.

Si falla la clasificación, se conserva el texto sin clasificar. Si falla la transcripción de una carga directa, vuelve a subir el archivo; en WhatsApp el trabajo queda en error y se puede reintentar desde el dashboard.

## Conectar WhatsApp (requiere configuración externa)

El adaptador está implementado, pero la conexión real requiere una app de Meta con WhatsApp Business, un número emisor del bot y un token con acceso a los medios. Puede usarse el número de pruebas de Meta durante el desarrollo. Tu número personal es el remitente permitido, no el número del bot.

1. Configura `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, un `WHATSAPP_VERIFY_TOKEN` aleatorio y `WHATSAPP_ALLOWED_FROM` con tu número en formato internacional sin `+`.
2. Expón el servidor mediante un proxy HTTPS o un despliegue que termine TLS. Configura `HOST=0.0.0.0` si lo requiere tu plataforma y **antes** configura `DASHBOARD_USER` y una contraseña larga en `DASHBOARD_PASSWORD`. No expongas autenticación Basic sin HTTPS. El servidor rechaza escuchar fuera de loopback sin contraseña.
3. En Meta, registra el endpoint público HTTPS `/webhook` con el mismo token de verificación y suscribe el campo `messages` de WhatsApp Business.
4. Envía un audio desde el número permitido y comprueba su transcripción y clasificación en el dashboard. Los errores de procesamiento se muestran en **Entrada de WhatsApp**.

El endpoint valida las firmas HMAC de Meta, confirma recepción antes de procesar, persiste los trabajos y evita duplicados por identificador de mensaje. Solo acepta texto y audio del número permitido; si falta `WHATSAPP_ALLOWED_FROM`, no ingiere mensajes. Los trabajos que estaban procesándose se recuperan al reiniciar; los errores requieren reintento manual. No se envían respuestas, confirmaciones ni recordatorios por WhatsApp en esta versión.

Para la conexión externa se necesitan destinos HTTPS: `api.openai.com`, `graph.facebook.com` y los destinos de medios admitidos `lookaside.fbsbx.com` / `lookaside.facebook.com`. La recepción del webhook también necesita un endpoint HTTPS público; una lista de destinos salientes no proporciona ese endpoint. El adaptador usa Graph API v23.0.

## Datos y límites

- Uso personal, un único proceso de servidor. No implementa cuentas múltiples.
- SQLite conserva originales, elementos y la cola de mensajes. Haz copias de `data/` con el servidor detenido. Protege el disco: SQLite no está cifrado por esta app.
- Los audios se procesan en memoria y no se conservan en disco; para reprocesarlos directamente hay que subirlos otra vez. Meta puede limitar la disponibilidad de sus medios.
- Al usar IA, el audio y el texto se envían a OpenAI; al usar WhatsApp, también interviene Meta. Revisa qué información laboral puedes enviar a estos proveedores.
- Los recordatorios solo aparecen en el dashboard: no hay notificaciones, alarmas ni envío programado.
- El dashboard muestra fechas con el formato local del navegador; la interpretación por IA usa `TIMEZONE`.
- No hay eliminación de notas desde la interfaz ni sincronización externa en esta versión.

## Validación

`npm test` comprueba autenticación, bloqueo de escrituras desde otro origen, persistencia tras reinicio, edición de varios elementos, validación de fechas, verificación y firma del webhook, restricción del remitente y deduplicación. Estas pruebas no consumen servicios externos ni acreditan una conexión real a Meta/OpenAI. La recepción y transcripción reales requieren completar la configuración y realizar una prueba con un audio propio.
