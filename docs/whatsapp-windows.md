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

## 2. Actualizar Hilo y guardar la configuración

1. Detén Hilo con Ctrl+C. Descarga **Code → Download ZIP** desde https://github.com/Dest996/Prueba1/tree/hilo-inicial y extrae en otra carpeta.
2. Copia la carpeta `data` y tu archivo `.env` anteriores a la carpeta nueva, si existen. Conserva la carpeta anterior hasta comprobar tus notas. No copies encima el `.env.example`: es una plantilla.
3. Abre `cmd` en la carpeta nueva que contiene `package.json`. Ejecuta:

   ```bat
   npm run configurar:whatsapp
   ```

4. El asistente solicita tu número personal con código de país, el **Phone number ID** del bot, el **App Secret** y el **Access token**. Los dos últimos permanecen ocultos. Se conservan tu proveedor de IA, sus claves y tus demás ajustes.
5. El asistente genera un **WHATSAPP_VERIFY_TOKEN** aleatorio y configura **WHATSAPP_WEBHOOK_PORT=3001**, salvo que ya tengas otro puerto válido. Este token lo crea Hilo: no es ninguno de los tokens de Meta. Si necesitas copiarlo a Meta, abre `.env` con Bloc de notas y copia solo el valor de esa línea. No muestres ni compartas el archivo completo.
6. Ejecuta `npm start`. Debes ver el dashboard en el puerto 3000 y el receptor de WhatsApp en el 3001. Si configuraste otros puertos, usa los que muestra tu instalación.
7. En el dashboard de tu equipo pulsa **Comprobar acceso a Meta**. Esto solo consulta el número; no envía mensajes. Una respuesta correcta confirma acceso al número, pero no acredita todavía el webhook ni la recepción de audios.
8. Comprueba también la IA mediante **Comprobar IA**. Los audios necesitan tu proveedor de IA funcionando; la cuota de Gemini es independiente de Meta.

## 3. Obtener una dirección HTTPS de pruebas

Para que Meta contacte con el equipo necesitas un túnel mientras Hilo está ejecutándose. En estas pruebas se publica únicamente el receptor de mensajes, no el dashboard.

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

Los túneles rápidos de Cloudflare no son un alojamiento permanente ni garantizan disponibilidad. Tu PC, Hilo y el túnel deben seguir encendidos. Para uso continuo habrá que desplegar un servidor con dominio HTTPS estable y almacenamiento persistente. No abras puertos en el router para este recorrido.

## 4. Registrar el webhook en Meta

1. En la configuración de WhatsApp/Webhooks de tu app, configura la **Callback URL / URL de devolución de llamada** con la dirección HTTPS del túnel seguida de `/webhook`.
2. En **Verify token / Token de verificación**, pega el valor de `WHATSAPP_VERIFY_TOKEN` de tu `.env`.
3. Guarda y verifica. Hilo devuelve el desafío de Meta si el token coincide.
4. Suscribe el campo **messages** de WhatsApp Business. Verificar la URL por sí solo no suscribe la recepción de mensajes.
5. Comprueba que el webhook está asociado a la misma app, cuenta Business y número que configuraste. Si Meta exige una suscripción adicional de la app a la cuenta, complétala desde su flujo de configuración.

## 5. Probar una nota real

1. Crea un proyecto en Hilo, por ejemplo **Norte**.
2. Desde el WhatsApp de tu número personal autorizado, envía un texto al número de pruebas de Meta. Comprueba que aparece una nota en el dashboard; se actualiza cada pocos segundos.
3. Envía una nota de voz breve: “Para Norte, enviar el presupuesto el viernes. Además, se me ocurre ofrecer mantenimiento mensual”.
4. Comprueba la transcripción en **Ver original**, los elementos y el proyecto. Corrige lo que haga falta: las fechas ambiguas requieren revisión.
5. No esperes respuesta en el chat: esta versión recibe notas, pero no envía confirmaciones ni recordatorios.

## Si algo falla

- **Comprobar acceso a Meta falla:** comprueba el Phone number ID, los permisos y la caducidad del token. Para actualizarlo, ejecuta otra vez `npm run configurar:whatsapp` y reinicia Hilo. El token de verificación existente se conserva.
- **No se puede verificar la URL:** Hilo y el túnel deben estar activos, la URL debe terminar en `/webhook`, y el token debe coincidir. Si reiniciaste el túnel, actualiza su dirección en Meta.
- **Meta verifica la URL pero no llegan notas:** comprueba la suscripción al campo `messages`, la asociación de la app y el número, y tu número remitente autorizado. Hilo filtra otros remitentes y otros identificadores del número del bot.
- **Aparecen errores en Entrada de WhatsApp:** revisa el token y la IA. Puedes reintentar desde el dashboard. Si Meta ya no permite descargar un audio antiguo, envía una grabación nueva.
- **El audio supera el límite:** usa uno más corto (14 MB con Gemini, 20 MB con OpenAI).
- **El texto funciona pero no el audio:** revisa la cuota de IA y los permisos de descarga. Hilo verifica el hash del medio cuando Meta lo proporciona y rechaza archivos cuya integridad no coincide.

Las firmas y el recorrido completo de recepción se prueban con servicios simulados. Solo tu primer audio real permite validar Meta, el túnel, los permisos y tu proveedor de IA en conjunto. Las condiciones y precios de producción de WhatsApp son independientes de la cuota gratuita de IA; consúltalos antes de pasar del número de pruebas a uno permanente.
