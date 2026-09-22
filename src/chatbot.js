import {
  loginCampus,
  getCursosActuales,
  getHorarioDetallado,
  getProximasSesiones,
  getPagosPendientes,
  getRegistroActual,
  getAvanceCarrera,
} from './campus.js';

const GRAPH_BASE = 'https://graph.facebook.com/v25.0';

async function enviarWhatsApp(env, payload) {
  const respuesta = await fetch(`${GRAPH_BASE}/${env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  if (!respuesta.ok) {
    console.error('Error enviando WhatsApp', respuesta.status, await respuesta.text());
  }
}

export async function enviarTexto(env, para, texto) {
  await enviarWhatsApp(env, { to: para, type: 'text', text: { body: texto } });
}

export async function enviarMenu(env, para) {
  await enviarWhatsApp(env, {
    to: para,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Asistente académico' },
      body: { text: '¿Qué quieres consultar?' },
      action: {
        button: 'Ver opciones',
        sections: [
          {
            title: 'Consultas rápidas',
            rows: [
              { id: 'menu_horario_hoy', title: 'Horario de hoy' },
              { id: 'menu_proxima_clase', title: 'Próxima clase (Zoom)' },
              { id: 'menu_cursos', title: 'Mis cursos' },
              { id: 'menu_notas', title: 'Mis notas / avance' },
              { id: 'menu_pagos', title: 'Pagos pendientes' },
            ],
          },
          {
            title: 'Otro',
            rows: [{ id: 'menu_libre', title: 'Otra pregunta' }],
          },
        ],
      },
    },
  });
}

// --- Opciones del menú: llaman directo al campus y formatean texto fijo,
// sin pasar por Claude (costo cero de API en estas rutas). ---

async function manejarHorarioHoy(cookie) {
  const datos = await getProximasSesiones(cookie);
  if (datos.sesionesHoy.length === 0) {
    return `📅 Hoy (${datos.hoy}) no tienes clases.`;
  }
  const lineas = datos.sesionesHoy.map((s) => `• ${s.fecha} — ${s.asignatura}\n  ${s.enlace}`);
  return `📅 Hoy (${datos.hoy}):\n\n${lineas.join('\n\n')}`;
}

async function manejarProximaClase(cookie) {
  const datos = await getProximasSesiones(cookie);
  const proxima = datos.sesionesHoy[0] || datos.sesionesProximas[0];
  if (!proxima) return 'No encontré ninguna sesión programada próximamente.';
  return `⏰ Tu próxima clase:\n\n${proxima.asignatura}\n${proxima.fecha}\n\n🔗 ${proxima.enlace}`;
}

async function manejarCursos(cookie) {
  const cursos = await getCursosActuales(cookie);
  const lineas = cursos.map(
    (c) => `• ${c.asignatura} — ${c.docente}\n  ${c.horario || 'sin horario asignado'} (${c.estado})`
  );
  return `📚 Tus cursos de este periodo:\n\n${lineas.join('\n\n')}`;
}

async function manejarNotas(cookie) {
  const nPerAluRegCodigo = await getRegistroActual(cookie);
  const { cursos, avance } = await getAvanceCarrera(cookie, nPerAluRegCodigo);
  const aprobados = cursos.filter((c) => c.estado === 'APROBADA');
  const enProceso = cursos.filter((c) => c.estado === 'EN PROCESO');
  const lineasAprobados = aprobados.map((c) => `• ${c.asignatura}: ${c.nota}`).join('\n');
  const lineasProceso = enProceso.map((c) => `• ${c.asignatura} (en curso)`).join('\n');
  const resumenAvance = avance ? `\n\n🎓 Avance: ${avance.creditosAprobados}/${avance.creditosTotales} créditos aprobados.` : '';
  return `📊 Notas:\n\n${lineasAprobados}\n\nEn proceso este periodo:\n${lineasProceso}${resumenAvance}`;
}

async function manejarPagos(cookie) {
  const pagos = await getPagosPendientes(cookie);
  if (pagos.length === 0) return '✅ No tienes pagos pendientes.';
  const lineas = pagos.map((p) => `• Cuota ${p.NroCuota} — S/ ${p.TotalText} — vence ${p.FecVenc}`);
  return `💰 Pagos pendientes:\n\n${lineas.join('\n')}`;
}

const HANDLERS_MENU = {
  menu_horario_hoy: manejarHorarioHoy,
  menu_proxima_clase: manejarProximaClase,
  menu_cursos: manejarCursos,
  menu_notas: manejarNotas,
  menu_pagos: manejarPagos,
};

export async function manejarOpcionMenu(env, para, idOpcion) {
  if (idOpcion === 'menu_libre') {
    await enviarTexto(env, para, 'Escríbeme tu pregunta y te respondo 🙂');
    return;
  }
  const handler = HANDLERS_MENU[idOpcion];
  if (!handler) {
    await enviarTexto(env, para, 'No reconocí esa opción, escribe "menu" para ver las opciones de nuevo.');
    return;
  }
  try {
    const cookie = await loginCampus(env);
    const texto = await handler(cookie);
    await enviarTexto(env, para, texto);
  } catch (error) {
    console.error('Error consultando el campus', error);
    await enviarTexto(env, para, '⚠️ No pude consultar el campus virtual ahora mismo. Intenta de nuevo en un momento.');
  }
}

// --- Pregunta libre: pasa por Claude con tool-calling sobre el campus. ---

const HERRAMIENTAS = [
  {
    name: 'get_horario_detallado',
    description: 'Devuelve el calendario completo de sesiones del periodo, con fecha exacta, hora, curso, ambiente y docente.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_proximas_sesiones',
    description: 'Devuelve las sesiones de Zoom de hoy y las próximas programadas, con enlace directo para unirse.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_cursos',
    description: 'Devuelve los cursos matriculados en el periodo actual: profesor, horario semanal, fechas, syllabus.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_notas_avance',
    description: 'Devuelve las notas de los cursos aprobados, los cursos en proceso, y el avance de créditos de la carrera.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_pagos_pendientes',
    description: 'Devuelve las cuotas pendientes de pago, con monto y fecha de vencimiento.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function ejecutarHerramienta(cookie, nombre) {
  switch (nombre) {
    case 'get_horario_detallado':
      return getHorarioDetallado(cookie);
    case 'get_proximas_sesiones':
      return getProximasSesiones(cookie);
    case 'get_cursos':
      return getCursosActuales(cookie);
    case 'get_notas_avance': {
      const nPerAluRegCodigo = await getRegistroActual(cookie);
      return getAvanceCarrera(cookie, nPerAluRegCodigo);
    }
    case 'get_pagos_pendientes':
      return getPagosPendientes(cookie);
    default:
      throw new Error(`Herramienta desconocida: ${nombre}`);
  }
}

const SYSTEM_PROMPT = `Eres un asistente que responde preguntas sobre la vida académica del estudiante en la Universidad Autónoma del Perú, usando las herramientas disponibles para consultar datos reales de su campus virtual. Responde en español, corto y directo (esto es un chat de WhatsApp). Usa emojis con moderación. Si no tienes una herramienta que responda la pregunta, dilo claramente en vez de inventar datos.

Formato: esto es WhatsApp, no Markdown estándar. Para negrita usa *un solo asterisco* (no **dobles**), para cursiva _guion bajo_, y listas con guiones simples. Nunca uses **.`;

export async function responderPreguntaLibre(env, para, pregunta) {
  let cookie;
  try {
    cookie = await loginCampus(env);
  } catch (error) {
    console.error('Error de login al campus', error);
    await enviarTexto(env, para, '⚠️ No pude conectarme al campus virtual ahora mismo. Intenta de nuevo en un momento.');
    return;
  }

  const mensajes = [{ role: 'user', content: pregunta }];

  for (let vuelta = 0; vuelta < 4; vuelta++) {
    const respuesta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: HERRAMIENTAS,
        messages: mensajes,
      }),
    });

    if (!respuesta.ok) {
      console.error('Error llamando a Claude', respuesta.status, await respuesta.text());
      await enviarTexto(env, para, '⚠️ Tuve un problema respondiendo tu pregunta. Intenta de nuevo.');
      return;
    }

    const datos = await respuesta.json();
    mensajes.push({ role: 'assistant', content: datos.content });

    if (datos.stop_reason !== 'tool_use') {
      const textoFinal = datos.content.find((b) => b.type === 'text')?.text;
      await enviarTexto(env, para, textoFinal || 'No pude generar una respuesta.');
      return;
    }

    const bloquesHerramienta = datos.content.filter((b) => b.type === 'tool_use');
    const resultados = await Promise.all(
      bloquesHerramienta.map(async (bloque) => {
        try {
          const resultado = await ejecutarHerramienta(cookie, bloque.name);
          return { type: 'tool_result', tool_use_id: bloque.id, content: JSON.stringify(resultado) };
        } catch (error) {
          return { type: 'tool_result', tool_use_id: bloque.id, content: String(error), is_error: true };
        }
      })
    );
    mensajes.push({ role: 'user', content: resultados });
  }

  await enviarTexto(env, para, 'No pude terminar de resolver tu pregunta, intenta reformularla.');
}
