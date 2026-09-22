import { enviarMenu, manejarOpcionMenu, responderPreguntaLibre } from './chatbot.js';
import { loginCampus, getHorarioDetallado } from './campus.js';

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC-5, sin horario de verano

function fechaISOLima(offsetDiasMs = 0) {
  return new Date(Date.now() - LIMA_OFFSET_MS + offsetDiasMs).toISOString().slice(0, 10);
}

function fechaLegible(fechaISO, prefijo) {
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  const diaSemana = DIAS_SEMANA[fecha.getUTCDay()];
  return `${prefijo} ${diaSemana} ${dia} de ${MESES[mes - 1]}`;
}

// DD/MM/YYYY (formato del campus) -> YYYY-MM-DD
function fechaISODesdeCampus(cFecha) {
  const [dia, mes, anio] = cFecha.split('/');
  return `${anio}-${mes}-${dia}`;
}

// El campus no manda un campo "tipo" explícito: cAmbiente vale "Asesoría"
// para las asesorías y "ZOOM"/"Zoom" para la clase en vivo.
function tipoSesion(cAmbiente) {
  return (cAmbiente || '').toLowerCase().includes('asesor') ? 'Asesoría' : 'EN VIVO';
}

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

// Los dos cron triggers configurados en wrangler.toml
const CRON_RESUMEN_HOY = '0 12 * * *'; // 07:00 Lima
const CRON_AVISO_MANANA = '0 2 * * *'; // 21:00 Lima (día siguiente en UTC)

// Palabras que muestran el menú interactivo en vez de ir directo a Claude
const PALABRAS_MENU = new Set(['menu', 'menú', 'hola', 'inicio', 'ayuda']);

async function manejarMensajeEntrante(env, mensaje) {
  const para = mensaje.from;

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
      ctx.waitUntil(enviarRecordatorio(env, fechaISOLima(), 'Hoy'));
    } else if (event.cron === CRON_AVISO_MANANA) {
      ctx.waitUntil(enviarRecordatorio(env, fechaISOLima(24 * 60 * 60 * 1000), 'Mañana'));
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
        const cuerpo = await request.json();
        const mensaje = cuerpo.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (mensaje) {
          ctx.waitUntil(manejarMensajeEntrante(env, mensaje));
        }
        return new Response('OK', { status: 200 });
      }

      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/debug-horario') {
      if (!env.TEST_TOKEN || url.searchParams.get('token') !== env.TEST_TOKEN) {
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
      if (!env.TEST_TOKEN || url.searchParams.get('token') !== env.TEST_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
      // Suscribe explícitamente la WABA a esta app: sin esto, el webhook a
      // nivel de app puede estar bien configurado y aun así no recibir
      // mensajes reales. Va contra el WABA ID, no el phone_number_id.
      const wabaId = url.searchParams.get('waba_id') || env.PHONE_NUMBER_ID;
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
    if (!env.TEST_TOKEN || url.searchParams.get('token') !== env.TEST_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    const fechaParam = url.searchParams.get('fecha');
    const fechaObjetivo = fechaParam || fechaISOLima();
    // {{1}} siempre es "Hoy <fecha>" o "Mañana <fecha>"; por defecto "Hoy",
    // salvo que se pida explícitamente lo contrario con ?prefijo=Mañana
    const prefijo = url.searchParams.get('prefijo') || 'Hoy';

    // Override temporal para probar con una plantilla ya activa (ej.
    // hello_world) mientras la propia sigue en revisión en Meta:
    // /test?token=...&plantilla=hello_world&idioma=en_US
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
