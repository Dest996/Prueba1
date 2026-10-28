# Conectar WhatsApp desde cero en Windows

Este recorrido usa la API oficial de WhatsApp de Meta y un número de pruebas proporcionado por Meta. Tu WhatsApp personal sirve para enviar las notas al número del bot. La app recibe texto y audios; no envía mensajes de respuesta ni recordatorios.

Necesitas una cuenta de Meta/Facebook, poder crear una app para WhatsApp Business y acceso a la configuración que Meta solicite. Meta puede pedir un portafolio comercial y verificaciones; los nombres y requisitos de las pantallas pueden variar según tu cuenta. No es necesario migrar tu número personal para este recorrido con el número de pruebas.

## 1. Crear la app y obtener el número de pruebas

1. Entra en https://developers.facebook.com/apps/ e inicia sesión. Completa el registro de desarrollador si Meta lo solicita.
2. Pulsa **Crear app**. Selecciona el caso de uso de **WhatsApp / conectar con clientes a través de WhatsApp** que aparezca en tu cuenta. Si tu pantalla pide primero un tipo de app, sigue el flujo de empresa compatible con WhatsApp. Si Meta solicita un portafolio comercial, crea o selecciona uno siguiendo sus instrucciones.
3. Dentro de la app, abre **WhatsApp → Configuración de la API** o **API Setup**. Busca el número de pruebas que ofrece Meta.
4. Añade tu número personal como destinatario de pruebas y completa su verificación. Selecciónalo cuando pruebes el número de Meta. Si Meta no habilita el número de pruebas, termina los requisitos que indique en esa pantalla antes de continuar.
5. Identifica estos datos, pero no los pegues en chats:
   - **Phone number ID / Identificador del número de teléfono:** un identificador numérico del número del bot. No es tu teléfono, el número visible del bot ni el WhatsApp Business Account ID.
   - **Access token:** token de acceso con permisos para ese número. Los tokens de pruebas suelen expirar; revisa la caducidad indicada por Meta.
   - **App Secret / Clave secreta de la app:** se encuentra en la configuración básica de la app; Meta puede pedirte que confirmes tu identidad para mostrarla. No es el App ID.

No publiques capturas con estos datos. El token se configura en tu equipo mediante el asistente, que lo oculta al escribirlo.

## 2. Actualizar AL DÍA y guardar la configuración

1. Detén AL DÍA con Ctrl+C. Descarga **Code → Download ZIP** desde https://github.com/Dest996/Prueba1/tree/hilo-inicial y extrae en otra carpeta.
2. Si ya tienes AL DÍA, actualiza la misma carpeta siguiendo [Actualizar esta versión en Windows](../README.md#actualizar-esta-versión-en-windows). Conserva `.env` y `data` en su ubicación actual. No reemplaces tu `.env` con `.env.example`: es solo una plantilla.
3. Abre `cmd` en la carpeta nueva que contiene `package.json`. Ejecuta:

   ```bat
   npm run configurar:whatsapp
   ```

4. El asistente solicita tu número personal con código de país, el **Phone number ID** del bot, el **App Secret** y el **Access token**. Los dos últimos permanecen ocultos. Se conservan tu proveedor de IA, sus claves y tus demás ajustes.
5. El asistente genera un **WHATSAPP_VERIFY_TOKEN** aleatorio y configura **WHATSAPP_WEBHOOK_PORT=3001**, salvo que ya tengas otro puerto válido. Este token lo crea AL DÍA: no es ninguno de los tokens de Meta. Si necesitas copiarlo a Meta, abre `.env` con Bloc de notas y copia solo el valor de esa línea. No muestres ni compartas el archivo completo.
6. Ejecuta `npm start`. Debes ver el dashboard en el puerto 3000 y el receptor de WhatsApp en el 3001. Si configuraste otros puertos, usa los que muestra tu instalación.
7. Entra como administrador y abre **Configuración → Comprobar acceso a Meta**. Esto solo consulta el número; no envía mensajes. Una respuesta correcta confirma acceso al número, pero no acredita todavía el webhook ni la recepción de audios.
8. Comprueba también la IA mediante **Configuración → Comprobar IA**. Los audios necesitan tu proveedor de IA funcionando; la cuota de Gemini es independiente de Meta.

## 3. Obtener una dirección HTTPS de pruebas

Para que Meta contacte con el equipo necesitas un túnel mientras AL DÍA está ejecutándose. En estas pruebas se publica únicamente el receptor de mensajes, no el dashboard.

1. Instala la herramienta oficial cloudflared desde otra terminal de Windows:

   ```bat
   winget install --id Cloudflare.cloudflared --exact
   ```

   Si Windows no tiene winget, sigue la instalación oficial para Windows: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

2. Cierra y abre una nueva terminal después de instalar para que se actualice el PATH. Mantén abierta la terminal donde corre `npm start`.
3. Ejecuta en la nueva terminal:

   ```bat
   cloudflared tunnel --url http://127.0.0.1:3001
   ```

   Si elegiste otro `WHATSAPP_WEBHOOK_PORT`, sustituye 3001. **No apuntes el túnel al puerto del dashboard (3000 por defecto)**. El receptor separado solo sirve `/webhook`; el resto de rutas devuelve 404.

4. cloudflared mostrará una dirección HTTPS terminada en `.trycloudflare.com`. Cópiala y añade `/webhook` al final para obtener tu URL de devolución de llamada. Es una URL de pruebas: puede cambiar al reiniciar el túnel. No escribas literalmente los puntos suspensivos de un ejemplo.

Los túneles rápidos de Cloudflare no son un alojamiento permanente ni garantizan disponibilidad. Tu PC, AL DÍA y el túnel deben seguir encendidos. Para uso continuo habrá que desplegar un servidor con dominio HTTPS estable y almacenamiento persistente. No abras puertos en el router para este recorrido.

## 4. Registrar el webhook en Meta

1. En la configuración de WhatsApp/Webhooks de tu app, configura la **Callback URL / URL de devolución de llamada** con la dirección HTTPS del túnel seguida de `/webhook`.
2. En **Verify token / Token de verificación**, pega el valor de `WHATSAPP_VERIFY_TOKEN` de tu `.env`.
3. Guarda y verifica. AL DÍA devuelve el desafío de Meta si el token coincide.
4. Suscribe el campo **messages** de WhatsApp Business. Verificar la URL por sí solo no suscribe la recepción de mensajes.
5. Comprueba que el webhook está asociado a la misma app, cuenta Business y número que configuraste. Si Meta exige una suscripción adicional de la app a la cuenta, complétala desde su flujo de configuración.

## Si las pruebas de Meta llegan, pero los mensajes reales no

Activar el campo `messages` y verificar la URL son pasos distintos de suscribir la app a la cuenta de WhatsApp Business. Si una prueba deja un evento en AL DÍA pero un texto real no genera otro evento, comprueba esa asociación.

Con AL DÍA y Cloudflare abiertos, abre otra terminal en la carpeta que contiene tu `.env` y ejecuta:

```bat
node --env-file=.env scripts/subscribe-whatsapp.js
```

Introduce el **Identificador de la cuenta WhatsApp Business** que aparece en **Paso 1. Probar**, junto al Phone Number ID. El comando lee el token de tu configuración; no lo solicita ni lo muestra. Comprueba que la cuenta contiene el número configurado y solicita `POST /{WABA_ID}/subscribed_apps` para suscribir la app asociada a ese token. Es una operación adicional que no elimina las otras apps suscritas. No envía mensajes ni cambia tu URL o tus claves.

Necesitas que el usuario del sistema tenga acceso a la cuenta y que su token incluya `whatsapp_business_management`. Si Meta confirma la suscripción, envía un texto **nuevo** desde el remitente autorizado al número de pruebas y revisa `events`. La confirmación de la suscripción todavía no acredita la entrega de mensajes. Si la cuenta no contiene el número, el comando se detiene antes de modificarla.

## 5. Probar una nota real

1. Crea un proyecto en AL DÍA, por ejemplo **Norte**.
2. Desde el WhatsApp de tu número personal autorizado, envía un texto al número de pruebas de Meta. Comprueba que aparece una nota en el dashboard; se actualiza cada pocos segundos.
3. Envía una nota de voz breve: “Para Norte, enviar el presupuesto el viernes. Además, se me ocurre ofrecer mantenimiento mensual”.
4. Comprueba la transcripción en **Ver original**, los elementos y el proyecto. Corrige lo que haga falta: las fechas ambiguas requieren revisión.
5. Espera una confirmación breve del bot. Para probar un recordatorio escribe «Recuérdame en 2 minutos revisar la prueba». Vincula los números de cada usuario desde **Usuarios**; para avisos posteriores a 24 horas sigue la [configuración de plantillas](../README.md#plantilla-de-meta-para-avisos-después-de-24-horas).

## Si algo falla

En la sección WhatsApp del dashboard, abre **Diagnóstico de recepción de WhatsApp** para ver las últimas diez entregas registradas. Distingue mensajes aceptados, duplicados, remitentes y números del bot que no coinciden con la configuración, firmas inválidas y avisos sin notas. Guarda únicamente la hora y un resumen; no guarda claves ni cuerpos del mensaje en ese diagnóstico. Una prueba de Meta puede usar datos ficticios que el filtro rechace, aunque la conexión responda HTTP 200. Para diagnosticar la recepción real, envía un texto nuevo desde tu teléfono y comprueba si aparece un evento nuevo con esa hora. Si solo aparecen las pruebas y no tus mensajes reales, revisa la suscripción de la app a tu cuenta de WhatsApp Business, además del campo `messages`.

- **Comprobar acceso a Meta falla:** comprueba el Phone number ID, los permisos y la caducidad del token. Para actualizarlo, ejecuta otra vez `npm run configurar:whatsapp` y reinicia AL DÍA. El token de verificación existente se conserva.
- **No se puede verificar la URL:** AL DÍA y el túnel deben estar activos, la URL debe terminar en `/webhook`, y el token debe coincidir. Si reiniciaste el túnel, actualiza su dirección en Meta.
- **Meta verifica la URL pero no llegan notas:** comprueba la suscripción al campo `messages`, la asociación de la app y el número, y tu número remitente autorizado. AL DÍA filtra otros remitentes y otros identificadores del número del bot.
- **Aparecen errores en Entrada de WhatsApp:** revisa el token y la IA. Puedes reintentar desde el dashboard. Si Meta ya no permite descargar un audio antiguo, envía una grabación nueva.
- **El audio supera el límite:** usa uno más corto (14 MB con Gemini, 20 MB con OpenAI).
- **El texto funciona pero no el audio:** revisa la cuota de IA y los permisos de descarga. AL DÍA verifica el hash del medio cuando Meta lo proporciona y rechaza archivos cuya integridad no coincide.

Las firmas y el recorrido completo de recepción se prueban con servicios simulados. Solo tu primer audio real permite validar Meta, el túnel, los permisos y tu proveedor de IA en conjunto. Las condiciones y precios de producción de WhatsApp son independientes de la cuota gratuita de IA; consúltalos antes de pasar del número de pruebas a uno permanente.

## Usuarios, respuestas y recordatorios

Cada número personal se vincula a una cuenta desde **Usuarios → Editar acceso → WhatsApp**. En un número de pruebas de Meta, añade también cada destinatario en el panel de pruebas. El número emisor del bot sigue siendo el mismo. Puedes administrar tu propio número desde **Configuración → Bot**. El `WHATSAPP_ALLOWED_FROM` anterior se importa solo al administrador y no es una lista de todos los participantes.

Para comprobar el diálogo, envía `Recuérdame llamar a Norte` sin fecha ni hora. El bot debe pedir ambas en una sola pregunta. Responde `mañana a las 09:00`: se completa el mismo recordatorio. No se pide proyecto. Para una prueba rápida completa usa `Recuérdame en 2 minutos revisar la prueba`.

Para un aviso a más de 24 horas del último mensaje de una persona, crea y espera la aprobación de la plantilla descrita en el README; después configura su nombre e idioma exactos en **Configuración → Bot**. No basta con que el webhook funcione. Los estados de envío, los bloqueos y los reintentos se consultan con **Actualizar envíos**. Mantén AL DÍA, el equipo y el túnel funcionando para recibir respuestas y enviar avisos.
