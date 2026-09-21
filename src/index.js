import horario from '../horario.json';

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

function sesionesDelDia(fechaISO) {
  return horario[fechaISO] || [];
}

function formatearSesiones(sesiones) {
  return sesiones.map((s) => `• ${s.inicio}–${s.fin} — ${s.curso} (${s.tipo})`).join('\n');
}

function hayEnVivo(sesiones) {
  return sesiones.some((s) => s.tipo === 'EN VIVO');
}

async function enviarRecordatorio(env, fechaISO, prefijo) {
  const sesiones = sesionesDelDia(fechaISO);
  if (sesiones.length === 0) {
    return { enviado: false, motivo: 'sin_clases', fecha: fechaISO };
  }

  const encabezado = fechaLegible(fechaISO, prefijo);
  const cuerpo = formatearSesiones(sesiones) + (hayEnVivo(sesiones) ? '' : '\n⚠️ Ninguna es EN VIVO.');

  const payload = {
    messaging_product: 'whatsapp',
    to: env.DESTINATARIO,
    type: 'template',
    template: {
      name: env.WHATSAPP_TEMPLATE_NAME || 'recordatorio_clases',
      language: { code: env.WHATSAPP_TEMPLATE_LANG || 'es' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: encabezado },
            { type: 'text', text: cuerpo },
          ],
        },
      ],
    },
  };

  let respuesta;
  try {
    respuesta = await fetch(`https://graph.facebook.com/v21.0/${env.PHONE_NUMBER_ID}/messages`, {
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

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === CRON_RESUMEN_HOY) {
      ctx.waitUntil(enviarRecordatorio(env, fechaISOLima(), 'Hoy'));
    } else if (event.cron === CRON_AVISO_MANANA) {
      ctx.waitUntil(enviarRecordatorio(env, fechaISOLima(24 * 60 * 60 * 1000), 'Mañana'));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== '/test') {
      return new Response('Not found', { status: 404 });
    }
    if (!env.TEST_TOKEN || url.searchParams.get('token') !== env.TEST_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    const fechaParam = url.searchParams.get('fecha');
    const fechaObjetivo = fechaParam || fechaISOLima();
    const prefijo = fechaParam ? '' : 'Hoy';

    const resultado = await enviarRecordatorio(env, fechaObjetivo, prefijo);
    return new Response(JSON.stringify(resultado, null, 2), {
      headers: { 'Content-Type': 'application/json' },
      status: resultado.enviado || resultado.motivo === 'sin_clases' ? 200 : 502,
    });
  },
};
