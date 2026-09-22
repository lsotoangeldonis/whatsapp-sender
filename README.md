# whatsapp-sender

Asistente académico por WhatsApp para el campus virtual de la Universidad
Autónoma del Perú, corriendo como un único Cloudflare Worker (sin servidor
propio). Combina recordatorios automáticos (Cron Triggers) con un chatbot
interactivo que consulta el campus virtual en vivo.

## Estado actual

✅ **Desplegado y en producción** en
`https://whatsapp-sender.lsotoangeldonis.workers.dev`.

✅ **Recordatorios automáticos** (resumen 07:00, aviso 21:00, alerta ~15 min
antes de cada clase, aviso de pagos por vencer) leyendo el horario **en vivo**
desde el campus virtual — no hay nada que resembrar cada ciclo académico.

✅ **Chatbot interactivo** sobre el mismo Worker (`/webhook`): menú de
WhatsApp con navegación determinista (horario, cursos, sesiones, notas,
pagos, grabaciones, anuncios, configuración de alertas) y fallback a Claude
(Haiku 4.5) con tool-calling para preguntas libres.

## Arquitectura

```
src/
  index.js        Entry point del Worker: scheduled() (crons) + fetch() (webhook/rutas de test)
  chatbot.js       Menú de WhatsApp, handlers de cada opción, y el loop de Claude para preguntas libres
  campus.js        Cliente del campus virtual: login + caché de sesión + PageMethods
  preferencias.js  Preferencias de alertas (on/off), persistidas en Workers KV
  fechas.js        Helpers de fecha/hora compartidos (todo en hora Lima, UTC-5 fijo)
```

No hay base de datos ni backend propio. Workers KV guarda solo estado
efímero o reconstruible: las preferencias de alertas, el dedupe de la
alerta de próxima clase, y dos cachés con TTL (el horario y la cookie de
sesión del campus) que existen para no martillar el campus con logins —
ver "Volumen de logins al campus".

Los datos siguen viniendo **del campus en vivo**: cursos, notas, pagos,
grabaciones y anuncios se consultan en cada request, y el horario se
refresca solo dos veces al día. Nada de eso se guarda en el repo (es
información personal) ni hay que sembrarlo a mano al cambiar de ciclo.

## Cron Triggers

Configurados en `wrangler.toml` (`[triggers] crons`), todos evaluados en
`index.js` dentro de `scheduled()`:

| Cron (UTC) | Hora Lima | Qué hace | Toggle que lo controla |
|---|---|---|---|
| `0 12 * * *` | 07:00 | Resumen de las clases de **hoy** (mensaje de plantilla) + revisa pagos por vencer (≤3 días) | `resumenHoy` / `proximoPago` |
| `0 2 * * *` | 21:00 (día previo) | Aviso de las clases de **mañana** (mensaje de plantilla) | `avisoManana` |
| `*/15 * * * *` | cada 15 min | Alerta de texto libre cuando una sesión de hoy empieza en 8–22 min | `proximaClase` |

Los tres respetan las preferencias guardadas en KV (ver "Configurar alertas"
más abajo) — si un toggle está apagado, el cron corre igual pero no envía
nada para esa alerta.

- **Resumen/aviso** (07:00 y 21:00) se envían como **mensaje de plantilla**
  aprobada por Meta (`recordatorio_clases`), porque el envío es automático y
  siempre cae fuera de la ventana de 24h de conversación de WhatsApp.
- **Alerta de próxima clase** y **alerta de pago** se envían como **texto
  libre** (`enviarTexto`) — esto solo funciona dentro de la ventana de 24h
  desde el último mensaje del usuario al bot. En la práctica, como el
  usuario interactúa seguido con el chatbot, la ventana casi siempre está
  abierta; si no lo está, el envío falla silenciosamente (se loguea el
  error pero no hay reintento ni fallback a plantilla).
- **Alerta de próxima clase**: ventana de detección 8–22 minutos de
  anticipación (para no perderse el aviso entre dos corridas de 15 min),
  con dedupe en KV (`alerta_clase:<fechaISO>:<horaInicio>:<curso>`, TTL 24h)
  para no repetir el mismo aviso en la siguiente corrida.
- **Alerta de pago**: corre una vez al día (enganchada al cron de 07:00),
  compara `FecVenc` de cada cuota pendiente contra hoy, avisa si vence en
  0–3 días.

Cloudflare Free tier soporta hasta 3 Cron Triggers por Worker y 100k
invocaciones/día — el cron cada 15 minutos son ~96 invocaciones/día, muy
lejos del límite.

## Chatbot (WhatsApp interactivo)

### Cómo se entra al menú

Escribir **"menu"** (o "menú", "hola", "inicio", "ayuda") muestra el menú
principal. Cualquier otro texto libre se manda a Claude con tool-calling.

El bot responde **únicamente al número configurado en `DESTINATARIO`**:
cualquier mensaje de otro número se descarta en silencio (ver "Seguridad").

### Menú principal

Mensaje interactivo tipo **lista** (WhatsApp limita a **10 filas en total**
entre todas las secciones — el menú principal está exactamente en ese
límite, por eso las opciones nuevas se agregan como submenús en vez de
filas sueltas):

**Sección "Consultas rápidas":**
- 📅 Horario → abre el submenú de horario
- Próxima clase (Zoom) → próxima sesión con link directo de Zoom
- Mis cursos → lista de cursos matriculados con docente, horario y sílabo
- Ver un curso → lista de cursos → lista de sesiones → contenido de la sesión
- Mis notas / avance → notas de cursos aprobados + avance de créditos
- Pagos pendientes → cuotas pendientes con monto y vencimiento
- Grabaciones recientes → últimas 5 grabaciones de Zoom (todos los cursos)
- Anuncios y eventos → últimos 5 posts del tablero de la universidad

**Sección "Otro":**
- Otra pregunta → invita a escribir texto libre (va a Claude)
- ⚙️ Configurar alertas → submenú de toggles

### Submenú "📅 Horario"

6 opciones, todas agrupan `getHorarioDetallado` (el mismo endpoint que usa
el recordatorio automático) por rango de fechas en hora Lima:

- **Hoy** / **Mañana** / **Esta semana** / **Siguiente semana** — formato
  "detallado" (`formatearBloques`): un bloque por fecha con día de la
  semana, y una línea por sesión (hora, curso, tipo).
- **Este mes** / **Siguiente mes** — formato "compacto" (`formatearLineas`):
  una sola línea por fecha (día abreviado + todas las sesiones separadas por
  `·`), para no acercarse al límite de 4096 caracteres de un mensaje de
  WhatsApp; si aun así se pasa de ~3800 caracteres, se trunca con un aviso.

"Semana" va de lunes a domingo (`lunesDeSemana()`); "mes" va del día 1 al
último día del mes calendario.

Nota: **"Próxima clase (Zoom)"** es una fuente de datos distinta
(`getProximasSesiones`, basada en `start_url` de Zoom) — no pasa por
`getHorarioDetallado` porque es la única que trae el link directo para
unirse a la reunión.

### "Ver un curso" (navegación de 3 niveles)

1. `menu_ver_curso` → lista los cursos matriculados (`curso_<nGruCodigo>`).
2. Elegir un curso → lista sus sesiones (`sesion_<nGruCodigo>_<numSesion>`),
   ordenadas **descendente** (más reciente primero), con etiquetas
   `(Actual)` en la sesión activa y `(Última)` en la sesión cerrada más
   reciente. Como WhatsApp limita a 10 filas, la ventana de 10 sesiones se
   **centra en la sesión activa** (no siempre son las 10 de número más
   alto — un curso con muchas sesiones futuras ya cargadas en el sílabo
   dejaría fuera la actual/última si se tomara el corte ingenuo).
3. Elegir una sesión → devuelve texto con: sílabo (link), rango de fechas de
   la sesión, tema/logro de la semana, recursos de esa sesión específica
   (links de tipo "Enlace"; los de tipo "Archivo" no traen URL confirmada,
   así que solo se menciona que están en el campus virtual), y la
   grabación de Zoom si existe (cruzada por asignatura + número de sesión
   contra `getGrabaciones`).

### "⚙️ Configurar alertas"

Lista con 4 toggles (✅ activo / 🔕 apagado), uno por cada notificación
automática del sistema — **incluye los dos crons originales de resumen y
aviso, no solo las alertas nuevas**:

| Campo (KV) | Etiqueta en el menú | Controla |
|---|---|---|
| `resumenHoy` | Resumen 07:00 | Cron 07:00, resumen de clases de hoy |
| `avisoManana` | Aviso 21:00 | Cron 21:00, aviso de clases de mañana |
| `proximaClase` | Próxima clase | Alerta cada 15 min, ~15 min antes de cada sesión |
| `proximoPago` | Próximo pago | Aviso de cuotas que vencen en ≤3 días |

Tocar una fila invierte ese campo, lo guarda en KV
(`preferencias.js` → `guardarPreferenciasAlertas`) y vuelve a mostrar la
lista actualizada. Todos empiezan en `true` por defecto (ver
`POR_DEFECTO` en `src/preferencias.js`).

### Preguntas libres → Claude con tool-calling

Cualquier texto que no sea "menu"/saludo se manda a
`claude-haiku-4-5` (Messages API) con un loop de tool-calling (máx. 4
vueltas) sobre estas herramientas, todas ejecutadas contra el campus en
vivo (`ejecutarHerramienta` en `chatbot.js`):

| Herramienta | Qué devuelve |
|---|---|
| `get_horario_detallado` | Calendario completo del periodo (fecha, hora, curso, ambiente, docente) |
| `get_proximas_sesiones` | Sesiones de Zoom de hoy y próximas, con link |
| `get_cursos` | Cursos matriculados: docente, horario, fechas, sílabo |
| `get_notas_avance` | Notas de cursos aprobados/en proceso + avance de créditos |
| `get_pagos_pendientes` | Cuotas pendientes con monto y vencimiento |
| `get_contenido_curso` | Sílabo + temario semana a semana + recursos de un curso (param `curso`) |
| `get_grabaciones` | Grabaciones de Zoom pasadas, opcionalmente filtradas por curso |
| `get_anuncios` | Anuncios/eventos recientes del tablero de la universidad |

**Formato WhatsApp, no Markdown estándar**: el `SYSTEM_PROMPT` instruye
explícitamente a Claude a usar `*negrita con un solo asterisco*` (no
`**doble**`, que WhatsApp no renderiza), `_cursiva_` y listas con guiones
simples — esto costó un bug real (Claude usaba `**` por default) antes de
agregar la instrucción.

## Volumen de logins al campus

Antes, `loginCampus()` corría en cada invocación que tocaba el campus: con
la alerta de próxima clase activa eran ~96 logins/día solo del cron de 15
minutos, más uno por cada opción de menú. No es un riesgo de seguridad,
pero un campus con detección de logins repetidos puede bloquear la cuenta
sin aviso. Hay dos cachés en KV que lo bajan a menos de 10/día:

**1. Caché del horario (`horario_cache`, TTL 26 h).** El cron de 15 min solo
necesita saber si alguna clase empieza pronto, y el calendario cambia como
mucho una vez al día. `obtenerHorarioCacheado()` lo lee de KV y hace **cero
logins**; `obtenerHorarioFresco()` consulta el campus y reescribe el caché,
y lo usan los recordatorios de 07:00 y 21:00 (que ya hacían login igual) y
`/test`. Resultado: el cron pasa de ~96 logins/día a 0, y el refresco queda
en ~2/día.

Esto **no** vuelve al modelo viejo de sembrar el horario a mano: el refresco
es automático, así que se sigue adaptando solo a un ciclo nuevo o a un
cambio de calendario, con hasta un día de lag. Si el caché está vacío
(primer arranque, o TTL vencido porque los cron dejaron de correr), la
lectura cae sola a una consulta en vivo y lo repuebla. Costo en KV: ~2
escrituras/día contra un límite de 1000, y ~96 lecturas contra 100 000.

**2. Caché de la cookie de sesión (`cookie_campus`, TTL 15 min).**
`obtenerCookie(env)` reutiliza la cookie mientras siga válida, así que una
navegación curso → sesiones → contenido usa 1 login en vez de 3-4.

El TTL es conservador porque el real no está confirmado (ASP.NET Forms Auth
suele usar 20-30 min deslizantes). Lo que hace viable el caché es el
reintento: con la sesión vencida el campus **no devuelve un error**,
redirige a `Login.aspx`, así que la respuesta pasa a ser HTML en vez del
JSON del PageMethod. `llamarMetodo()` detecta eso y lanza `SesionExpirada`;
`conSesion(env, operacion)` la captura, hace login nuevo y reintenta una
sola vez. Solo reintenta ante ese error concreto — un 500 del campus se
propaga tal cual, sin reintento ni login extra.

Todas las rutas que tocan el campus pasan por `conSesion()`. En
`responderPreguntaLibre` el reintento envuelve cada herramienta por
separado, no la conversación completa, para no re-gastar tokens de Claude
si la sesión expira a mitad de camino.

> Nota: la cookie cacheada es una sesión viva del campus guardada en KV.
> Quien tenga acceso a tu cuenta de Cloudflare podría leerla, pero esa
> misma persona ya tendría acceso a `CAMPUS_PASSWORD` en los secrets del
> Worker, así que no es una escalada real — y expira en 15 minutos.

## Endpoints del campus virtual (reverse-engineered)

Todos son PageMethods de ASP.NET: `POST` con `Content-Type:
application/json; charset=UTF-8` y header `X-Requested-With:
XMLHttpRequest`, autenticados con las cookies de sesión. La respuesta viene
envuelta como `{"d": "<json-string>"}` — `llamarMetodo()` en `campus.js`
hace el parse doble (`JSON.parse(datos.d)`).

### Login

`POST /Campus/Login.aspx` reproduce el flujo de **ASP.NET Forms
Authentication**: primero un `GET` a la misma URL para extraer
`__VIEWSTATE`/`__VIEWSTATEGENERATOR`/`__EVENTVALIDATION` (tokens de un solo
uso atados a la sesión) y la cookie `ASP.NET_SessionId`, luego un `POST`
con esos tokens más `txtUsuario`/`txtPassword`. La respuesta trae la cookie
`.ASPXFORMSAUTH`. La cookie combinada (`ASP.NET_SessionId=...;
.ASPXFORMSAUTH=...`) es la que se manda en cada llamada posterior — no hay
sesión persistente entre requests del Worker, se hace login en cada
invocación (`loginCampus()`).

### PageMethods usados

| Endpoint | Payload | Uso |
|---|---|---|
| `/Campus/Default.aspx/Alu_ObtenerCursosActuales` | `{}` | Cursos matriculados del periodo actual (`getCursosActuales`), incluye `nGruCodigo` (clave para cruzar con sesiones/grabaciones) y `cSilabo` (link relativo al sílabo) |
| `/CampusVirtual/ua/Alumno/MisCursos/Alu_HorarioClase.aspx/Alu_ObtenerHorarioClase` | `{cAsignatura: '', cPerCodigo: '', cTablas: 'HORARIO_DETALLADO,HORARIO_DE_HOY,HORARIO_ACTUAL', nPerAluRegCodigo: 0}` | Calendario completo de sesiones (`getHorarioDetallado`), se usa `HORARIO_DETALLADO`: `cFecha` (DD/MM/YYYY), `cHoraInicio`, `cHoraFin`, `cAsignatura`, `cAmbiente`, `cDocente` |
| `/Campus/Default.aspx/obtenerSesionesVirtualesHoyProxima` | `{}` | Sesiones de Zoom de hoy y próximas con `start_url` (`getProximasSesiones`) |
| `/Campus/ua/MisFinanzas/Camp_Virt_PagosPendientes.aspx/Alu_ObtenerPagosPendientes` | `{cPerCodigo: ''}` | Cuotas pendientes (`getPagosPendientes`): `NroCuota`, `TotalText`, `FecVenc` (DD/MM/YYYY) |
| `/Campus/ua/Tablero/Perfil/Camp_Virt_Perfil.aspx/USP_CAMP_ObtenerCurriculas_By_cPercodigo` | `{cAcion: 2}` | Resuelve `nPerAluRegCodigo` (matrícula del periodo activo) en vivo (`getRegistroActual`) — no se hardcodea porque cambia entre periodos |
| `/campus/ua/Tablero/Perfil/Camp_Virt_Perfil.aspx/ObtenerDataAvanceCarrera` | `{cPerCodigo: '', cTablas: 'Malla_Curricular,Malla_Curricular_grafAvanceCarrera', nPerAluRegCodigo}` | Malla curricular (notas, estado por curso) + avance de créditos (`getAvanceCarrera`) |
| `/Campus/Default.aspx/getInformationDetailCurso` | `{nGruCodigo: Number(nGruCodigo), nSesion: 0, nPerfil: 13}` | Sílabo semana a semana + recursos de un curso (`getDetalleSesionesCurso`). `nSesion: 0` + `nPerfil: 13` (perfil alumno) trae **todas** las sesiones, no una sola; `datos.silabo[].sesion_activa === 1` marca la sesión activa |
| `/Campus/Default.aspx/getCurriculaAlumno` | `{}` | Currículas del alumno, con `arrayPeriodo` (JSON serializado como string) — insumo para resolver `nCurCodigo`/`nPrdCodigo` que pide `obtenerCursosSesionesOnline` |
| `/Campus/ua/Tablero/Perfil/Camp_Virt_Perfil.aspx/getRequisitosIngresantesPersona` | `{nTipo: 1}` | Resuelve `cPerCodigo` (identificador interno del alumno, **distinto** del código universitario visible) del lado del servidor a partir de la sesión — ver nota abajo |
| `/CampusVirtual/SesionesOnline/Sesiones.aspx/obtenerCursosSesionesOnline` | `{nCurCodigo, cPerCodigo, nPrdCodigo}` | Grabaciones de Zoom por sesión (`getGrabaciones`): `grabaciones` viene como JSON-string con objetos `{play_url}`; se cruza con `sesionSemana` para saber a qué sesión del curso corresponde |
| `/CampusVirtual/ua/Def_Estudiante.aspx/getInfoAlumno` | `{endpoint: 'muro_web'}` | Tablero de anuncios/eventos de la universidad (`getMuro`): mismo feed que el Panel principal del campus. `pContenido` viene en HTML, se limpia con `quitarHtml()` |

**Nota sobre `cPerCodigo`**: en un primer intento se asumió que había que
pedirlo como input manual (nuevo GitHub Secret). Antes de agregarlo se
confirmó si algún endpoint ya lo devolvía — resultó que
`getRequisitosIngresantesPersona` lo resuelve completamente del lado del
servidor a partir de la cookie de sesión, así que **no hace falta ningún
secret nuevo**: `resolverCPerCodigo()` en `campus.js` lo pide on-demand,
en paralelo con `getCurriculaAlumno`, cada vez que se llama
`getGrabaciones`.

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

   Las plantillas de utilidad suelen aprobarse en minutos u horas. El
   nombre debe coincidir con `WHATSAPP_TEMPLATE_NAME` (por defecto
   `recordatorio_clases`) — ya está **aprobada y activa**, este paso solo
   hace falta si la recreas o agregas una plantilla nueva.
5. En **Business Suite → Configuración → Usuarios → Usuarios del sistema**,
   crea un usuario del sistema, asígnale la app de WhatsApp con permisos
   `whatsapp_business_messaging` y `whatsapp_business_management`, y genera un
   token **sin expiración**. Ese es el que se usa en el Worker (el token de la
   pantalla de API Setup dura solo 24 horas y no sirve).
6. Anota: el token permanente, el **Phone Number ID** y el
   **WhatsApp Business Account ID** (visibles en API Setup), y tu número de
   destino en formato internacional sin el signo más (ej. `51987654321`).
7. **Publica la app** (Casos de uso → Publicar) y **suscribe la WABA al
   webhook** — ver la sección siguiente. Sin esto, el webhook nunca recibe
   mensajes reales de usuarios (solo simulacros).

## Configuración del webhook (chatbot)

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

   ```bash
   curl -H "Authorization: Bearer <TEST_TOKEN>" \
     "https://<tu-worker>.workers.dev/subscribe-app?waba_id=<WABA_ID>"
   ```

   El `WABA_ID` (WhatsApp Business Account ID) se ve en la pantalla
   **API Setup**. Solo hace falta correrlo una vez, salvo que Meta la
   des-suscriba (ej. tras cambios grandes en la app). Si se llama con el ID
   equivocado (ej. `phone_number_id` en vez del WABA ID), la Graph API
   responde `Unsupported post request. Object with ID '...' does not
   exist...` (code 100, subcode 33) — hay que usar el WABA ID, no el
   Phone Number ID.
5. Copia la **clave secreta de la app** (App Dashboard → Configuración →
   Básica → "Clave secreta de la aplicación" → Mostrar) al secret
   `META_APP_SECRET`. Es lo que permite verificar que cada POST al webhook
   viene realmente de Meta — ver "Seguridad" abajo.

## Seguridad

La URL del Worker es pública por diseño (Meta necesita poder llamarla) y el
número del bot es visible para cualquiera que reciba un mensaje suyo, así
que el control de acceso está en el código, en dos capas independientes:

**1. Verificación de la firma de Meta (`X-Hub-Signature-256`).** Cada
callback real de Meta viene firmado con un HMAC-SHA256 del cuerpo crudo,
usando el App Secret. El Worker recalcula ese HMAC y lo compara con
`crypto.subtle.verify` (comparación en tiempo constante) **antes** de
parsear el JSON o tocar su contenido; si no coincide, responde 403 y no
hace nada más. Sin esto, cualquiera que descubriera la URL podría mandar
un POST falsificado por `curl`, inventando el campo `from`, sin pasar por
WhatsApp. Falla cerrado: si `META_APP_SECRET` no está configurado, ningún
POST se procesa.

**2. Allowlist del remitente.** `manejarMensajeEntrante` descarta en
silencio cualquier mensaje cuyo `from` no sea exactamente `DESTINATARIO`.
Se descarta sin responder, a propósito: contestar "no autorizado"
confirmaría que el número está activo y gastaría una llamada a la API.
Esto protege de que otro número que consiga el número del bot pueda leer
horario, notas, **pagos pendientes**, grabaciones o anuncios, apagar las
alertas (las preferencias son globales, no por número), o gastar la cuota
de `ANTHROPIC_API_KEY` mandando preguntas libres.

Las dos capas son deliberadamente redundantes: la firma valida que el
mensaje viene de Meta, y la allowlist valida de quién es el mensaje. Ni
una ni otra sola alcanza.

**3. Endpoints administrativos.** `/test`, `/debug-horario` y
`/subscribe-app` exigen el `TEST_TOKEN` en la cabecera
`Authorization: Bearer <token>`, **no** en la query string: con
`observability` activado, Cloudflare guarda la URL completa de cada
invocación, así que un `?token=...` quedaría persistido en los logs (y en
el historial del navegador). La comparación es en tiempo constante.

**4. Validación de `waba_id`.** `/subscribe-app` interpola ese parámetro en
una URL de `graph.facebook.com` en una petición que lleva tu
`WHATSAPP_TOKEN`. Sin validarlo, un valor con `../` redirige el POST a otra
ruta de la Graph API llevándose el token, así que se exige que sea
numérico.

**5. Datos del campus como datos, no instrucciones.** Lo que devuelven las
herramientas (sobre todo los anuncios del muro, que los publican terceros)
entra al contexto de Claude como `tool_result`. El `SYSTEM_PROMPT` le
indica explícitamente que ese contenido es data y que nunca debe seguir
instrucciones incrustadas ahí, ni avalar enlaces que vengan de un anuncio.

**Lo que no está cubierto — rate limiting.** No hay límite de tasa propio y
**es deliberado**: después de los puntos 1–4, todo request no autenticado
muere en el 401/403 antes de tocar Claude, el campus o la Graph API, así
que lo único que puede gastar es invocaciones del Worker. Implementar
contadores en KV costaría una escritura por request contra un límite de
1000 escrituras/día en el plan Free — el "arreglo" se quedaría sin cuota
mucho antes que lo que pretende proteger. Si algún día hace falta, el lugar
correcto es Cloudflare WAF Rate Limiting (a nivel de zona, no en el
Worker).

## Fase B — Proyecto local

```bash
npm install
```

## Fase C — Credenciales y despliegue

### Opción A (recomendada): despliegue automático con GitHub Actions

El workflow `.github/workflows/deploy.yml` despliega el Worker en cada push a
`main`, o manualmente desde la pestaña **Actions** del repo (botón
"Run workflow"). Corre en los servidores de GitHub, así que no depende de tu
máquina ni de la red de quien lo ejecute. **Este es también el único
mecanismo de despliegue usado en este proyecto** (el sandbox de desarrollo
no tiene salida de red hacia Cloudflare/Meta/el campus).

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
   | `TEST_TOKEN` | Uno propio, aleatorio, para proteger los endpoints `/test`, `/debug-horario` y `/subscribe-app` |
   | `WHATSAPP_TEMPLATE_NAME` | Nombre de la plantilla aprobada (ej. `recordatorio_clases`) |
   | `WHATSAPP_TEMPLATE_LANG` | Código de idioma de la plantilla (ej. `es`) |
   | `ANTHROPIC_API_KEY` | Clave de la Claude Console, para el chatbot (preguntas libres, tool-calling) |
   | `CAMPUS_USUARIO` | Usuario del campus virtual |
   | `CAMPUS_PASSWORD` | Contraseña del campus virtual |
   | `WEBHOOK_VERIFY_TOKEN` | Uno propio, aleatorio, para el handshake de verificación del webhook de Meta |
   | `META_APP_SECRET` | **Clave secreta de la app** de Meta (App Dashboard → Configuración → Básica → "Mostrar"). Con esto se verifica la firma de cada webhook — sin él, el Worker rechaza todos los POST |

   No hace falta ningún secret para `cPerCodigo` — se resuelve dinámicamente
   en cada request (ver sección de endpoints).

   > ⚠️ `META_APP_SECRET` debe existir **antes** del primer deploy que
   > incluya la verificación de firma. El Worker falla cerrado: si el
   > secret está vacío, todo POST a `/webhook` responde 403 y el chatbot
   > deja de contestar (los crons siguen funcionando normal).

2. Ve a la pestaña **Actions → Deploy Worker → Run workflow**, elige esta
   rama y ejecútalo. También se dispara solo en cada push a `main`.
3. Revisa el log del job: la acción `cloudflare/wrangler-action` imprime la
   URL del Worker desplegado (`https://whatsapp-sender.<tu-subdominio>.workers.dev`).
4. **Namespace de KV** — ya está creado (`HORARIO_KV`, ver `wrangler.toml`).
   Guarda cuatro cosas, todas efímeras o reconstruibles:

   | Clave | TTL | Qué es |
   |---|---|---|
   | `alertas` | sin TTL | Preferencias de alertas (los 4 toggles del menú) |
   | `alerta_clase:<fecha>:<hora>:<curso>` | 24 h | Dedupe de la alerta de próxima clase |
   | `horario_cache` | 26 h | Horario del periodo, para que el cron de 15 min no consulte el campus |
   | `cookie_campus` | 15 min | Cookie de sesión del campus reutilizable |

   La clave `horario` del diseño original (sembrada a mano) ya no se usa
   — ver "Legado" más abajo; `horario_cache` es otra cosa: se refresca sola.

### Opción B: desde tu propia terminal

```bash
npx wrangler login

npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put PHONE_NUMBER_ID
npx wrangler secret put DESTINATARIO
npx wrangler secret put TEST_TOKEN
npx wrangler secret put WHATSAPP_TEMPLATE_NAME   # opcional, default: recordatorio_clases
npx wrangler secret put WHATSAPP_TEMPLATE_LANG   # opcional, default: es
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CAMPUS_USUARIO
npx wrangler secret put CAMPUS_PASSWORD
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put META_APP_SECRET

npm run deploy
```

## Workflows de GitHub Actions

| Workflow | Trigger | Qué hace |
|---|---|---|
| `deploy.yml` | Push a `main`, o manual | Despliega el Worker con `wrangler deploy` (secrets vía `cloudflare/wrangler-action`). |
| `check-template.yml` | **Solo manual** | Prueba el endpoint `/test` real contra una fecha fija, con la plantilla configurada por defecto. Acepta un input opcional `extra` para overrides (ej. `plantilla=hello_world&idioma=en_US`). |
| `setup-kv.yml` | Manual | *(Legado, ver abajo)* Crea el namespace `HORARIO_KV` en Cloudflare. Ya no hace falta salvo que se borre el namespace. |
| `seed-kv.yml` | Manual | *(Legado, ver abajo)* Sube el contenido del secret `HORARIO_JSON` a KV bajo la clave `horario`. Nada en el código actual lee esa clave. |

> ⚠️ **`check-template.yml` nunca debe llevar un trigger `schedule`.**
> Este workflow llama al endpoint `/test` **real** — si la plantilla ya está
> aprobada, cada corrida envía un WhatsApp de verdad. Úsalo solo con
> `workflow_dispatch` manual, puntual.

### Legado: `HORARIO_JSON` / `setup-kv.yml` / `seed-kv.yml`

El diseño original leía el horario desde una copia estática en Workers KV,
sembrada a mano desde el secret `HORARIO_JSON` cada vez que cambiaba el
periodo académico. Esto se migró a lectura en vivo desde
`getHorarioDetallado` (ver `obtenerHorario()` en `index.js`) para que el
recordatorio se adapte solo a cualquier ciclo nuevo y a las excepciones de
calendario que resuelve el propio campus. El secret `HORARIO_JSON`, el
namespace KV bajo la clave `horario`, y los workflows `setup-kv.yml` /
`seed-kv.yml` quedaron sin uso — se mantienen en el repo por si se necesita
reactivar ese modo (ej. si el campus virtual cambia de endpoint y hace
falta un fallback estático), pero no son parte del flujo activo.

## Pruebas

> ⚠️ Con la plantilla ya aprobada, el endpoint `/test` **envía un WhatsApp
> real** cada vez que encuentra sesiones para la fecha consultada (no es un
> simulacro). Prefiere `curl` en vez del navegador: como `/test` ahora hace
> login + llamadas en vivo al campus, tarda más, y un reintento automático
> del navegador en una request lenta puede disparar el envío dos veces.

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

4. **Recordatorio manual.** El token va en la cabecera, no en la URL:

   ```bash
   curl -H "Authorization: Bearer <TEST_TOKEN>" \
     "https://<tu-worker>.workers.dev/test?fecha=2026-09-22"
   # → sesiones de esa fecha en vivo desde el campus (enviado: true) o sin_clases
   ```

5. **Horario crudo** (diagnóstico, sin enviar nada):

   ```bash
   curl -H "Authorization: Bearer <TEST_TOKEN>" \
     "https://<tu-worker>.workers.dev/debug-horario?curso=Programación"
   # → JSON con las sesiones de HORARIO_DETALLADO que matchean el filtro
   ```

6. **Chatbot**: escribe "menu" al número de WhatsApp configurado y navega las
   opciones; o escribe una pregunta libre para probar el tool-calling con
   Claude.
7. **Producción** — tras un deploy, revisa los logs con `npm run tail` y
   espera el primer disparo real. El dashboard de Cloudflare muestra el
   historial de ejecuciones de cada cron.

## Limitaciones conocidas

- **Ventana de 24 horas de WhatsApp**: los mensajes de texto libre (alertas
  de próxima clase/pago, y todas las respuestas del chatbot) solo se
  entregan si el usuario interactuó con el bot en las últimas 24h. El
  resumen/aviso diario esquiva esto usando plantilla aprobada.
- **5 destinatarios verificados como máximo** en modo prueba de Meta.
- **El número de test puede reciclarse** si la app queda inactiva mucho
  tiempo — si el envío falla de golpe, revisa que `PHONE_NUMBER_ID` siga
  siendo válido.
- **Cron Triggers de Cloudflare no son exactos al segundo** — pueden
  ejecutarse con algunos minutos de retraso; irrelevante para recordatorios
  diarios, y cubierto por la ventana de 8–22 min en la alerta de clase.
- **TTL de la cookie del campus sin confirmar**: el caché de sesión usa 15
  min por precaución, pero el valor real que usa el campus no se midió. Si
  fuera más corto, el reintento de `conSesion()` lo absorbe (al costo de un
  login extra); si fuera bastante más largo, se podría subir el TTL y
  ahorrar más. Ver "Volumen de logins al campus".
- **Recursos tipo "Archivo"** (PDF/PPT subidos al campus) no traen una URL
  absoluta confiable en la respuesta del endpoint — el bot solo avisa que
  están disponibles en el campus virtual, sin link directo.
- **Bot de un solo usuario por diseño**: la allowlist compara contra un
  único `DESTINATARIO` y las preferencias de alertas son globales. Soportar
  varios usuarios requeriría preferencias por número y una lista de
  números autorizados.
- **Alternativa**: si el tema de plantillas de WhatsApp se complica,
  Telegram Bot API es más simple (sin ventana de 24h, sin plantillas, sin
  verificación de negocio) y reutiliza el mismo Worker con un solo `fetch`.

## Decisiones tomadas

- Horario, cursos, notas, pagos, grabaciones y anuncios se consultan **en
  vivo** contra el campus virtual — nada de eso vive en el repo (es
  información personal) ni se cachea en KV.
- Envío automático en **tres** momentos: 07:00 (resumen de hoy), 21:00
  (aviso de mañana) y cada 15 min (alerta de próxima clase por empezar),
  más una revisión diaria de pagos por vencer — todos configurables on/off
  desde el propio chatbot.
- Se avisan **todas** las sesiones, EN VIVO y Asesoría.
- Canal: **WhatsApp Cloud API**, con Claude (Haiku 4.5) como fallback de
  lenguaje natural sobre las mismas fuentes de datos que usa el menú.
- El menú de WhatsApp se organiza en submenús (Horario; Ver un curso →
  sesiones → contenido; Configurar alertas) en vez de una lista plana,
  porque WhatsApp limita los mensajes tipo lista a 10 filas en total.
