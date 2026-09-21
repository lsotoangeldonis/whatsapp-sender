# whatsapp-sender

Recordatorio diario de clases por WhatsApp, usando un Cloudflare Worker con
Cron Triggers. Sin servidor propio, sin costo (mientras la WhatsApp Cloud API
se use en modo prueba y el Worker se mantenga en el plan Free de Cloudflare).

## Cómo funciona

Dos Cron Triggers (hora Lima, UTC-5):

- **07:00** → resumen de las clases de **hoy**.
- **21:00** → aviso de las clases de **mañana**.

El Worker lee `horario.json` (fechas literales, sin calcular por día de la
semana — el periodo tiene excepciones), arma el mensaje y lo envía por la
WhatsApp Cloud API como mensaje de plantilla (necesario porque los envíos son
automáticos y siempre caen fuera de la ventana de 24 horas de WhatsApp).

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

`horario.json` ya está generado a partir del calendario del periodo 202602
(59 días con clase, 72 sesiones).

## Fase C — Credenciales y despliegue

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
   # → fuera del periodo, sin_clases (no hay entrada en horario.json)
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
- Horario embebido en `horario.json` (versionado en git, sin dependencias).
