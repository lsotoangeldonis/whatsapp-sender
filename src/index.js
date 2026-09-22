import { enviarMenu, manejarOpcionMenu, responderPreguntaLibre, enviarTexto } from './chatbot.js';
import { loginCampus, getHorarioDetallado, getPagosPendientes } from './campus.js';
import { obtenerPreferenciasAlertas } from './preferencias.js';
import { fechaISOLima, fechaLegible, fechaISODesdeCampus, tipoSesion, LIMA_OFFSET_MS } from './fechas.js';

// El horario se consulta en vivo desde el campus virtual (ya no vive en
// Workers KV): así el recordatorio se adapta solo a cualquier ciclo nuevo,
// y las excepciones del calendario quedan resueltas por el propio campus.
async function obtenerHorario(env) {
  const cookie = await loginCampus(env);
  const sesiones = await getHorarioDetallado(cookie);
  const horario = {};
  for (const s of sesiones) {
    const fechaISO = fechaISODesdeCampus(s.cFecha);
    (horario[fechaISO] ||= []).push({
      inicio: s.cHoraInicio,
      fin: s.cHoraFin,
      curso: s.cAsignatura,
      tipo: tipoSesion(s.cAmbiente),
    });
  }
  return horario;
}

function sesionesDelDia(horario, fechaISO) {
  return horario[fechaISO] || [];
}

function formatearSesiones(sesiones) {
  // Meta rechaza (error 132018) parámetros de plantilla con saltos de línea,
  // tabs o más de 4 espacios seguidos: todo va en una sola línea.
  return sesiones.map((s) => `${s.inicio}–${s.fin} ${s.curso} (${s.tipo})`).join(' · ');
}

function hayEnVivo(sesiones) {
  return sesiones.some((s) => s.tipo === 'EN VIVO');
}

async function enviarRecordatorio(env, fechaISO, prefijo, opciones = {}) {
  let horario;
  try {
    horario = await obtenerHorario(env);
  } catch (error) {
    console.error('Error obteniendo el horario del campus', error);
    return { enviado: false, motivo: 'error_campus', error: String(error), fecha: fechaISO };
  }

  const sesiones = sesionesDelDia(horario, fechaISO);
  if (sesiones.length === 0) {
    return { enviado: false, motivo: 'sin_clases', fecha: fechaISO };
  }

  const encabezado = fechaLegible(fechaISO, prefijo);
  const cuerpo = formatearSesiones(sesiones) + (hayEnVivo(sesiones) ? '' : ' · ⚠️ Ninguna es EN VIVO.');

  const template = {
    name: opciones.plantilla || env.WHATSAPP_TEMPLATE_NAME || 'recordatorio_clases',
    language: { code: opciones.idioma || env.WHATSAPP_TEMPLATE_LANG || 'es' },
  };

  // opciones.sinParametros: para probar con una plantilla activa sin
  // variables (ej. hello_world) mientras la propia está en revisión.
  if (!opciones.sinParametros) {
    template.components = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: encabezado },
          { type: 'text', text: cuerpo },
        ],
      },
    ];
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: env.DESTINATARIO,
    type: 'template',
    template,
  };

  let respuesta;
  try {
    respuesta = await fetch(`https://graph.facebook.com/v25.0/${env.PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('Error de red al llamar a la Graph API', error);
    return { enviado: false, motivo: 'error_red', error: String(error), fecha: fechaISO };
  }

  const textoCrudo = await respuesta.text();
  let datos;
  try {
    datos = JSON.parse(textoCrudo);
  } catch {
    datos = { raw: textoCrudo };
  }

  if (!respuesta.ok) {
    console.error('Error al enviar WhatsApp', respuesta.status, JSON.stringify(datos));
    return { enviado: false, motivo: 'error_api', status: respuesta.status, datos, fecha: fechaISO };
  }

  return { enviado: true, datos, fecha: fechaISO };
}

// Los tres cron triggers configurados en wrangler.toml
const CRON_RESUMEN_HOY = '0 12 * * *'; // 07:00 Lima
const CRON_AVISO_MANANA = '0 2 * * *'; // 21:00 Lima (día siguiente en UTC)
const CRON_ALERTA_CLASE = '*/15 * * * *'; // cada 15 min, para avisar clases por empezar

// Avisa ~15 minutos antes de que empiece una sesión del día. Corre cada 15
// min, así que la ventana de detección (8 a 22 min de anticipación) cubre
// el intervalo entre corridas sin duplicar avisos gracias al dedupe en KV.
async function verificarAlertaClase(env) {
  const prefs = await obtenerPreferenciasAlertas(env);
  if (!prefs.proximaClase) return;

  let horario;
  try {
    horario = await obtenerHorario(env);
  } catch (error) {
    console.error('Error obteniendo el horario para la alerta de clase', error);
    return;
  }

  const fechaISO = fechaISOLima();
  const sesiones = sesionesDelDia(horario, fechaISO);
  const ahora = new Date(Date.now() - LIMA_OFFSET_MS);
  const minutosAhora = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();

  for (const s of sesiones) {
    const [h, m] = s.inicio.split(':').map(Number);
    const minutosInicio = h * 60 + m;
    const diff = minutosInicio - minutosAhora;
    if (diff < 8 || diff > 22) continue;

    const claveDedupe = `alerta_clase:${fechaISO}:${s.inicio}:${s.curso}`;
    if (await env.HORARIO_KV.get(claveDedupe)) continue;

    await enviarTexto(env, env.DESTINATARIO, `⏰ Tu clase de *${s.curso}* (${s.tipo}) empieza en ~15 minutos, a las ${s.inicio}.`);
    await env.HORARIO_KV.put(claveDedupe, '1', { expirationTtl: 60 * 60 * 24 });
  }
}

// Avisa cuando una cuota pendiente vence en 3 días o menos. Corre una vez
// al día, junto con el resumen de las 07:00.
async function verificarAlertaPago(env) {
  const prefs = await obtenerPreferenciasAlertas(env);
  if (!prefs.proximoPago) return;

  let cookie;
  try {
    cookie = await loginCampus(env);
  } catch (error) {
    console.error('Error de login para la alerta de pago', error);
    return;
  }

  const pagos = await getPagosPendientes(cookie);
  const hoyISO = fechaISOLima();
  const [anioHoy, mesHoy, diaHoy] = hoyISO.split('-').map(Number);
  const hoyUTC = Date.UTC(anioHoy, mesHoy - 1, diaHoy);

  for (const p of pagos) {
    const [dia, mes, anio] = p.FecVenc.split('/').map(Number);
    const venceUTC = Date.UTC(anio, mes - 1, dia);
    const diffDias = Math.round((venceUTC - hoyUTC) / 86400000);
    if (diffDias < 0 || diffDias > 3) continue;

    const cuando = diffDias === 0 ? 'hoy' : diffDias === 1 ? 'mañana' : `en ${diffDias} días`;
    await enviarTexto(env, env.DESTINATARIO, `💰 Recordatorio: la cuota ${p.NroCuota} (S/ ${p.TotalText}) vence ${cuando} (${p.FecVenc}).`);
  }
}

// Palabras que muestran el menú interactivo en vez de ir directo a Claude
const PALABRAS_MENU = new Set(['menu', 'menú', 'hola', 'inicio', 'ayuda']);

// Meta firma cada callback con HMAC-SHA256 del cuerpo crudo usando el App
// Secret. Sin verificarlo, cualquiera que descubra la URL del Worker puede
// falsificar mensajes por POST sin pasar por WhatsApp.
async function firmaValida(env, cuerpoCrudo, cabecera) {
  if (!env.META_APP_SECRET || !cabecera?.startsWith('sha256=')) return false;

  const firmaRecibida = hexABytes(cabecera.slice('sha256='.length));
  if (!firmaRecibida) return false;

  const clave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.META_APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  // crypto.subtle.verify compara en tiempo constante.
  return crypto.subtle.verify('HMAC', clave, firmaRecibida, cuerpoCrudo);
}

// SHA-256 son 32 bytes, o sea exactamente 64 caracteres hex.
function hexABytes(hex) {
  if (hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function cadenasIguales(a, b) {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

// El TEST_TOKEN va en la cabecera Authorization, no en la query string: con
// observability activado, Cloudflare guarda la URL completa de cada
// invocación, así que un ?token=... quedaría persistido en los logs (y en
// el historial del navegador).
function autorizado(request, env) {
  if (!env.TEST_TOKEN) return false;
  const cabecera = request.headers.get('authorization') || '';
  if (!cabecera.startsWith('Bearer ')) return false;
  return cadenasIguales(cabecera.slice('Bearer '.length), env.TEST_TOKEN);
}

async function manejarMensajeEntrante(env, mensaje) {
  const para = mensaje.from;

  // El bot atiende solo a su dueño. Cualquier otro número que consiga el
  // número del bot podría leer horario/notas/pagos y gastar la cuota de la
  // API de Claude, así que se descarta en silencio (sin responder, para no
  // confirmar siquiera que el número está activo).
  if (para !== env.DESTINATARIO) {
    console.warn('Mensaje descartado: número no autorizado', para);
    return;
  }

  if (mensaje.type === 'interactive' && mensaje.interactive?.type === 'list_reply') {
    await manejarOpcionMenu(env, para, mensaje.interactive.list_reply.id);
    return;
  }

  if (mensaje.type === 'text') {
    const texto = (mensaje.text?.body || '').trim().toLowerCase();
    if (PALABRAS_MENU.has(texto)) {
      await enviarMenu(env, para);
      return;
    }
    await responderPreguntaLibre(env, para, mensaje.text.body);
  }
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === CRON_RESUMEN_HOY) {
      ctx.waitUntil(
        (async () => {
          const prefs = await obtenerPreferenciasAlertas(env);
          if (prefs.resumenHoy) await enviarRecordatorio(env, fechaISOLima(), 'Hoy');
          await verificarAlertaPago(env);
        })()
      );
    } else if (event.cron === CRON_AVISO_MANANA) {
      ctx.waitUntil(
        (async () => {
          const prefs = await obtenerPreferenciasAlertas(env);
          if (prefs.avisoManana) await enviarRecordatorio(env, fechaISOLima(24 * 60 * 60 * 1000), 'Mañana');
        })()
      );
    } else if (event.cron === CRON_ALERTA_CLASE) {
      ctx.waitUntil(verificarAlertaClase(env));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/webhook') {
      if (request.method === 'GET') {
        const modo = url.searchParams.get('hub.mode');
        const token = url.searchParams.get('hub.verify_token');
        const challenge = url.searchParams.get('hub.challenge');
        if (modo === 'subscribe' && token === env.WEBHOOK_VERIFY_TOKEN) {
          return new Response(challenge, { status: 200 });
        }
        return new Response('Forbidden', { status: 403 });
      }

      if (request.method === 'POST') {
        // El HMAC se calcula sobre los bytes crudos: hay que leerlos antes
        // de parsear el JSON, y verificar antes de tocar el contenido.
        const cuerpoCrudo = await request.arrayBuffer();
        if (!(await firmaValida(env, cuerpoCrudo, request.headers.get('x-hub-signature-256')))) {
          console.warn('Webhook descartado: firma ausente o inválida');
          return new Response('Forbidden', { status: 403 });
        }

        const cuerpo = JSON.parse(new TextDecoder().decode(cuerpoCrudo));
        const mensaje = cuerpo.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (mensaje) {
          ctx.waitUntil(manejarMensajeEntrante(env, mensaje));
        }
        return new Response('OK', { status: 200 });
      }

      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/debug-horario') {
      if (!autorizado(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }
      const cookie = await loginCampus(env);
      const sesiones = await getHorarioDetallado(cookie);
      const filtro = url.searchParams.get('curso');
      const filtradas = filtro
        ? sesiones.filter((s) => (s.cAsignatura || '').toUpperCase().includes(filtro.toUpperCase()))
        : sesiones.slice(0, 3);
      return new Response(JSON.stringify(filtradas, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/subscribe-app') {
      if (!autorizado(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }
      // Suscribe explícitamente la WABA a esta app: sin esto, el webhook a
      // nivel de app puede estar bien configurado y aun así no recibir
      // mensajes reales. Va contra el WABA ID, no el phone_number_id.
      const wabaId = url.searchParams.get('waba_id') || env.PHONE_NUMBER_ID;
      // Sin validar, un waba_id con ../ redirige este POST a otra ruta de
      // graph.facebook.com llevándose el WHATSAPP_TOKEN en la cabecera.
      if (!/^\d+$/.test(wabaId)) {
        return new Response('waba_id inválido: debe ser numérico', { status: 400 });
      }
      const respuesta = await fetch(`https://graph.facebook.com/v25.0/${wabaId}/subscribed_apps`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
      });
      const datos = await respuesta.json();
      return new Response(JSON.stringify(datos, null, 2), {
        headers: { 'Content-Type': 'application/json' },
        status: respuesta.status,
      });
    }

    if (url.pathname !== '/test') {
      return new Response('Not found', { status: 404 });
    }
    if (!autorizado(request, env)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const fechaParam = url.searchParams.get('fecha');
    const fechaObjetivo = fechaParam || fechaISOLima();
    // {{1}} siempre es "Hoy <fecha>" o "Mañana <fecha>"; por defecto "Hoy",
    // salvo que se pida explícitamente lo contrario con ?prefijo=Mañana
    const prefijo = url.searchParams.get('prefijo') || 'Hoy';

    // Override temporal para probar con una plantilla ya activa (ej.
    // hello_world) mientras la propia sigue en revisión en Meta:
    // /test?plantilla=hello_world&idioma=en_US
    const plantillaOverride = url.searchParams.get('plantilla');
    const opciones = plantillaOverride
      ? { plantilla: plantillaOverride, idioma: url.searchParams.get('idioma') || 'en_US', sinParametros: true }
      : {};

    const resultado = await enviarRecordatorio(env, fechaObjetivo, prefijo, opciones);
    return new Response(JSON.stringify(resultado, null, 2), {
      headers: { 'Content-Type': 'application/json' },
      status: resultado.enviado || resultado.motivo === 'sin_clases' ? 200 : 502,
    });
  },
};
