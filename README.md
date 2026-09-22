# whatsapp-sender

Recordatorio diario de clases por WhatsApp, usando un Cloudflare Worker con
Cron Triggers. Sin servidor propio, sin costo (mientras la WhatsApp Cloud API
se use en modo prueba y el Worker se mantenga en el plan Free de Cloudflare).

## Estado actual

✅ **Desplegado y en producción** en
`https://whatsapp-sender.lsotoangeldonis.workers.dev`. La plantilla
`recordatorio_clases` fue aprobada por Meta el 22 de septiembre de 2026 y los
Cron Triggers (07:00 y 21:00 hora Lima) ya están enviando mensajes reales sin
intervención manual.

✅ **Chatbot interactivo** funcionando sobre el mismo Worker (`/webhook`):
menú de WhatsApp con respuestas deterministas contra el campus virtual, y
fallback a Claude (Haiku 4.5) con tool-calling para preguntas libres. Ver
sección "Chatbot" más abajo.

## Cómo funciona

Dos Cron Triggers (hora Lima, UTC-5):

- **07:00** → resumen de las clases de **hoy**.
- **21:00** → aviso de las clases de **mañana**.

El Worker lee el horario desde **Workers KV** (fechas literales, sin calcular
por día de la semana — el periodo tiene excepciones), arma el mensaje y lo
envía por la WhatsApp Cloud API como mensaje de plantilla (necesario porque
los envíos son automáticos y siempre caen fuera de la ventana de 24 horas de
WhatsApp).

El horario **no vive en este repositorio** — es información personal (tus
cursos, fechas y horarios reales). Vive únicamente en KV, en tu cuenta de
Cloudflare, sembrado una vez desde un GitHub Secret (ver Fase C).

Se incluyen **todas** las sesiones (EN VIVO y Asesoría) del día correspondiente.

## Chatbot (WhatsApp interactivo)

Además del recordatorio automático, el mismo Worker atiende mensajes
entrantes en `/webhook`:

- Al escribir **"menu"** (o "menú", "hola", "inicio", "ayuda") se envía un
  mensaje interactivo tipo lista con 5 consultas rápidas (horario de hoy,
  próxima clase, cursos, notas/avance, pagos pendientes) más la opción
  "Otra pregunta". Estas opciones llaman directo a `src/campus.js` y
  formatean texto fijo — **no pasan por Claude**, costo cero de API.
- Cualquier otro texto libre se manda a Claude (`claude-haiku-4-5`) con
  tool-calling sobre 5 herramientas que consultan el campus virtual en
  vivo (`src/chatbot.js`).
- `src/campus.js` reproduce el login de ASP.NET Forms Authentication del
  campus virtual (usuario/contraseña en `CAMPUS_USUARIO`/`CAMPUS_PASSWORD`)
  y llama a los PageMethods internos (`Alu_ObtenerCursosActuales`,
  `Alu_ObtenerHorarioClase`, `ObtenerDataAvanceCarrera`, etc.).

### Configuración del webhook en Meta

1. En tu app de Meta → **WhatsApp → Configuración → Webhook**, la URL de
   callback es `https://<tu-worker>.workers.dev/webhook` y el token de
   verificación debe coincidir con el secret `WEBHOOK_VERIFY_TOKEN`.
2. Suscribe el campo **`messages`**.
3. **La app debe estar en modo Live ("Publicada"), no en Development** —
   en Development, Meta solo entrega payloads simulados (botón "Probar"),
   nunca mensajes reales de usuarios. Publica la app desde **Casos de
   uso → Publicar** (puede pedir una URL de política de privacidad; basta
   con apuntar al README del repo, ej.
   `https://github.com/lsotoangeldonis/whatsapp-sender#readme`).
4. **La WABA debe estar suscrita a la app.** El webhook a nivel de app
   puede estar perfecto y aun así no recibir nada si este paso quedó
   pendiente (típico si el número de prueba se creó desde API Setup en
   vez de un flujo de Embedded Signup). Se hace con:

   ```
   POST https://graph.facebook.com/v25.0/<WABA_ID>/subscribed_apps
   Authorization: Bearer <WHATSAPP_TOKEN>
   ```

   El Worker expone un atajo protegido por `TEST_TOKEN` para esto:

   ```
   GET /subscribe-app?token=<TEST_TOKEN>&waba_id=<WABA_ID>
   ```

   El `WABA_ID` (WhatsApp Business Account ID) se ve en la pantalla
   **API Setup**. Solo hace falta correrlo una vez, salvo que Meta la
   des-suscriba (ej. tras cambios grandes en la app).

## Fase A — Meta (en el navegador, sin código)

1. Crea una app tipo **Business** en [developers.facebook.com](https://developers.facebook.com)
   y agrega el producto **WhatsApp**.
2. En la pantalla de **API Setup**, agrega tu celular como destinatario de
   prueba (hasta 5 números) y verifica el código que llega por WhatsApp.
3. Envía el mensaje de prueba `hello_world` desde esa misma pantalla.
   **Si esto no llega, no sigas** — el problema está en la configuración de
   Meta, no en el código.
4. Crea una **plantilla de utilidad** en Meta Business Manager (categoría
   *Utility*) con dos variables:

   ```
   Nombre: recordatorio_clases
   Idioma: es
   Cuerpo:
   Recordatorio de clases 📚
   {{1}}: {{2}}
   Mensaje automático de tu horario del periodo 202602.
   ```

   - `{{1}}` es el día en texto: `Hoy martes 22 de septiembre` o
     `Mañana martes 22 de septiembre`.
   - `{{2}}` es la lista de sesiones **en una sola línea**, separadas por
     ` · ` — Meta rechaza (error 132018) parámetros de plantilla con saltos
     de línea, tabs o más de 4 espacios seguidos. Ejemplo:
     `18:00–19:30 Análisis Integral en 3D (Asesoría) · 21:20–22:50 Programación Estructurada (Asesoría)`.

   Las plantillas de utilidad suelen aprobarse en minutos u horas (en este
   proyecto tardó cerca de 8 horas). El nombre debe coincidir con
   `WHATSAPP_TEMPLATE_NAME` (por defecto `recordatorio_clases`) — ya está
   **aprobada y activa**, este paso solo hace falta si la recreas o agregas
   una plantilla nueva (ej. para otro periodo académico).
5. En **Business Suite → Configuración → Usuarios → Usuarios del sistema**,
   crea un usuario del sistema, asígnale la app de WhatsApp con permisos
   `whatsapp_business_messaging` y `whatsapp_business_management`, y genera un
   token **sin expiración**. Ese es el que se usa en el Worker (el token de la
   pantalla de API Setup dura solo 24 horas y no sirve).
6. Anota: el token permanente, el **Phone Number ID** y el
   **WhatsApp Business Account ID** (visibles en API Setup), y tu número de
   destino en formato internacional sin el signo más (ej. `51987654321`).

## Fase B — Proyecto local

```bash
npm install
```

## Fase C — Credenciales y despliegue

### Opción A (recomendada): despliegue automático con GitHub Actions

El workflow `.github/workflows/deploy.yml` despliega el Worker en cada push a
`main`, o manualmente desde la pestaña **Actions** del repo (botón
"Run workflow"). Corre en los servidores de GitHub, así que no depende de tu
máquina ni de la red de quien lo ejecute.

1. En GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**, y agrega estos secrets (nunca quedan visibles después de
   guardarlos, ni en los logs del workflow):

   | Secret | Valor |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | El API Token creado en Cloudflare (plantilla "Edit Cloudflare Workers") |
   | `CLOUDFLARE_ACCOUNT_ID` | Tu Account ID de Cloudflare |
   | `WHATSAPP_TOKEN` | Token permanente del usuario del sistema (Fase A.5) |
   | `PHONE_NUMBER_ID` | De la pantalla API Setup |
   | `DESTINATARIO` | Tu número, formato internacional sin `+` (ej. `51987654321`) |
   | `TEST_TOKEN` | Uno propio, aleatorio, para proteger los endpoints `/test` y `/subscribe-app` |
   | `WHATSAPP_TEMPLATE_NAME` | Nombre de la plantilla aprobada (ej. `recordatorio_clases`) |
   | `WHATSAPP_TEMPLATE_LANG` | Código de idioma de la plantilla (ej. `es`) |
   | `HORARIO_JSON` | El contenido completo de tu horario en JSON (ver abajo) — solo se usa una vez para sembrar KV, nunca queda en el código |
   | `ANTHROPIC_API_KEY` | Clave de la Claude Console, para el fallback de preguntas libres del chatbot |
   | `CAMPUS_USUARIO` | Usuario del campus virtual |
   | `CAMPUS_PASSWORD` | Contraseña del campus virtual |
   | `WEBHOOK_VERIFY_TOKEN` | Uno propio, aleatorio, para el handshake de verificación del webhook de Meta |
   | `CAMPUS_PER_CODIGO` | Tu código interno de alumno (`cPerCodigo`), necesario para el endpoint de grabaciones de Zoom — no lo devuelve ningún endpoint, viene embebido en el HTML del campus |

2. Ve a la pestaña **Actions → Deploy Worker → Run workflow**, elige esta
   rama y ejecútalo. También se dispara solo en cada push a `main`.
3. Revisa el log del job: la acción `cloudflare/wrangler-action` imprime la
   URL del Worker desplegado (`https://whatsapp-sender.<tu-subdominio>.workers.dev`).
4. **Namespace de KV** — ya está creado (`HORARIO_KV`, ver `wrangler.toml`).
   Si alguna vez necesitas recrearlo desde cero: **Actions → Setup KV
   Namespace → Run workflow**, y copia el `id` que imprime el log al
   `[[kv_namespaces]]` de `wrangler.toml`.
5. **Sembrar el horario en KV** — con el secret `HORARIO_JSON` ya cargado:
   **Actions → Seed KV Horario → Run workflow**. Repite este paso cada vez
   que cambies el contenido del secret `HORARIO_JSON` (por ejemplo, para un
   nuevo periodo académico).

### Opción B: desde tu propia terminal

```bash
npx wrangler login

npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put PHONE_NUMBER_ID
npx wrangler secret put DESTINATARIO
npx wrangler secret put TEST_TOKEN          # token propio, para el endpoint /test
npx wrangler secret put WHATSAPP_TEMPLATE_NAME   # opcional, default: recordatorio_clases
npx wrangler secret put WHATSAPP_TEMPLATE_LANG   # opcional, default: es

npm run deploy
```

## Workflows de GitHub Actions

| Workflow | Trigger | Qué hace |
|---|---|---|
| `deploy.yml` | Push a `main`, o manual | Despliega el Worker con `wrangler deploy`. |
| `setup-kv.yml` | Manual | Crea el namespace `HORARIO_KV` en Cloudflare. Ya se corrió una vez; solo hace falta de nuevo si se borra el namespace. |
| `seed-kv.yml` | Manual | Sube el contenido del secret `HORARIO_JSON` a KV. Correr cada vez que cambie el horario (ej. nuevo periodo académico). |
| `check-template.yml` | **Solo manual** | Prueba el endpoint `/test` real contra la fecha `2026-09-22`, con la plantilla configurada por defecto. Acepta un input opcional `extra` para overrides (ej. `plantilla=hello_world&idioma=en_US`). |

> ⚠️ **`check-template.yml` nunca debe llevar un trigger `schedule`.**
> Este workflow llama al endpoint `/test` **real** — si la plantilla ya está
> aprobada, cada corrida envía un WhatsApp de verdad. Se usó temporalmente
> con un cron cada 20 minutos para monitorear la aprobación de la plantilla,
> y una vez aprobada empezó a duplicar el mensaje de producción cada 20
> minutos hasta que se detectó y se quitó el `schedule`. Úsalo solo con
> `workflow_dispatch` manual, puntual.

## Pruebas

> ⚠️ Con la plantilla ya aprobada, el endpoint `/test` **envía un WhatsApp
> real** cada vez que encuentra sesiones para la fecha consultada (no es un
> simulacro). Los ejemplos de fechas sin clases (`sin_clases`) siguen siendo
> inofensivos porque no llegan a llamar a la API de Meta.

1. **Meta funciona** — plantilla `hello_world` desde API Setup (Fase A.3).
2. **Credenciales desde la terminal**:

   ```bash
   curl -X POST "https://graph.facebook.com/v25.0/<PHONE_NUMBER_ID>/messages" \
     -H "Authorization: Bearer <WHATSAPP_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"messaging_product":"whatsapp","to":"<DESTINATARIO>","type":"template","template":{"name":"hello_world","language":{"code":"en_US"}}}'
   ```

3. **Worker local**:

   ```bash
   cp .dev.vars.example .dev.vars   # y completa tus valores reales
   npm run dev:cron
   ```

   Esto expone `/__scheduled` para disparar el cron a demanda sin esperar la
   hora real. Nota: `wrangler dev` usa por defecto un KV **local** vacío (no
   el namespace remoto), así que sin sembrarlo aparte va a devolver
   `sin_clases` para cualquier fecha. Para probar contra los datos reales
   localmente, agrega `--remote` a `npm run dev` / `npm run dev:cron`.

4. **Lógica de fechas** (usa el endpoint manual una vez desplegado, o
   `wrangler dev`):

   ```bash
   curl "https://<tu-worker>.workers.dev/test?token=<TEST_TOKEN>&fecha=2026-09-22"
   # → debe devolver dos asesorías (enviado: true)

   curl "https://<tu-worker>.workers.dev/test?token=<TEST_TOKEN>&fecha=2026-09-21"
   # → debe devolver sin_clases

   curl "https://<tu-worker>.workers.dev/test?token=<TEST_TOKEN>&fecha=2026-10-08"
   # → debe devolver sin_clases (excepción: no hay Programación Estructurada)

   curl "https://<tu-worker>.workers.dev/test?token=<TEST_TOKEN>&fecha=2026-12-20"
   # → fuera del periodo, sin_clases (no hay entrada en KV para esa fecha)
   ```

5. **Producción** — tras `npm run deploy`, revisa los logs con
   `npm run tail` y espera el primer disparo real. El dashboard de
   Cloudflare muestra el historial de ejecuciones del cron.

## Limitaciones conocidas

- **Ventana de 24 horas de WhatsApp**: como el envío es automático, siempre
  cae fuera de la ventana de conversación abierta. Por eso el mensaje se
  manda como plantilla aprobada (Fase A.4), no como texto libre.
- **5 destinatarios verificados como máximo** en modo prueba.
- **El número de test puede reciclarse** si la app queda inactiva mucho
  tiempo — si el envío falla de golpe, revisa que `PHONE_NUMBER_ID` siga
  siendo válido.
- **Cron Triggers de Cloudflare no son exactos al segundo** — pueden
  ejecutarse con algunos minutos de retraso, irrelevante para un recordatorio
  diario.
- **Alternativa**: si el tema de plantillas de WhatsApp se complica,
  Telegram Bot API es más simple (sin ventana de 24h, sin plantillas, sin
  verificación de negocio) y reutiliza el mismo Worker con un solo `fetch`.

## Decisiones tomadas

- Envío en **ambos** horarios: 07:00 (resumen de hoy) y 21:00 (aviso de
  mañana), hora Lima.
- Se avisan **todas** las sesiones, EN VIVO y Asesoría.
- Canal: **WhatsApp Cloud API**.
- Horario en **Workers KV**, fuera del repositorio (es información personal:
  tus cursos, fechas y horarios reales).
