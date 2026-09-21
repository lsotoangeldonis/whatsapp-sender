# whatsapp-sender

Recordatorio diario de clases por WhatsApp, usando un Cloudflare Worker con
Cron Triggers. Sin servidor propio, sin costo (mientras la WhatsApp Cloud API
se use en modo prueba y el Worker se mantenga en el plan Free de Cloudflare).

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

   Las plantillas de utilidad suelen aprobarse en minutos u horas. El nombre
   debe coincidir con `WHATSAPP_TEMPLATE_NAME` (por defecto
   `recordatorio_clases`).
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
   secret**, y agrega estos 9 secrets (nunca quedan visibles después de
   guardarlos, ni en los logs del workflow):

   | Secret | Valor |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | El API Token creado en Cloudflare (plantilla "Edit Cloudflare Workers") |
   | `CLOUDFLARE_ACCOUNT_ID` | Tu Account ID de Cloudflare |
   | `WHATSAPP_TOKEN` | Token permanente del usuario del sistema (Fase A.5) |
   | `PHONE_NUMBER_ID` | De la pantalla API Setup |
   | `DESTINATARIO` | Tu número, formato internacional sin `+` (ej. `51987654321`) |
   | `TEST_TOKEN` | Uno propio, aleatorio, para proteger el endpoint `/test` |
   | `WHATSAPP_TEMPLATE_NAME` | Nombre de la plantilla aprobada (ej. `recordatorio_clases`) |
   | `WHATSAPP_TEMPLATE_LANG` | Código de idioma de la plantilla (ej. `es`) |
   | `HORARIO_JSON` | El contenido completo de tu horario en JSON (ver abajo) — solo se usa una vez para sembrar KV, nunca queda en el código |

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

## Pruebas

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
   hora real.

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
