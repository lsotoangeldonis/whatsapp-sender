import {
  loginCampus,
  getCursosActuales,
  getHorarioDetallado,
  getProximasSesiones,
  getPagosPendientes,
  getRegistroActual,
  getAvanceCarrera,
  getDetalleSesionesCurso,
  getGrabaciones,
  getMuro,
} from './campus.js';
import { obtenerPreferenciasAlertas, guardarPreferenciasAlertas } from './preferencias.js';

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
              { id: 'menu_ver_curso', title: 'Ver un curso' },
              { id: 'menu_notas', title: 'Mis notas / avance' },
              { id: 'menu_pagos', title: 'Pagos pendientes' },
              { id: 'menu_grabaciones', title: 'Grabaciones recientes' },
              { id: 'menu_anuncios', title: 'Anuncios y eventos' },
            ],
          },
          {
            title: 'Otro',
            rows: [
              { id: 'menu_libre', title: 'Otra pregunta' },
              { id: 'menu_config_alertas', title: '⚙️ Configurar alertas' },
            ],
          },
        ],
      },
    },
  });
}

// --- Configuración de alertas (activar/desactivar), sin pasar por Claude. ---

const ETIQUETAS_TOGGLE = {
  resumenHoy: 'Resumen 07:00',
  avisoManana: 'Aviso 21:00',
  proximaClase: 'Próxima clase',
  proximoPago: 'Próximo pago',
};

async function enviarMenuAlertas(env, para) {
  const prefs = await obtenerPreferenciasAlertas(env);
  await enviarWhatsApp(env, {
    to: para,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Alertas' },
      body: { text: 'Toca una alerta para activarla o desactivarla.' },
      action: {
        button: 'Ver alertas',
        sections: [
          {
            title: 'Configuración',
            rows: Object.entries(ETIQUETAS_TOGGLE).map(([campo, etiqueta]) => ({
              id: `toggle_${campo}`,
              title: `${etiqueta} ${prefs[campo] ? '✅' : '🔕'}`,
            })),
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
    (c) =>
      `• ${c.asignatura} — ${c.docente}\n  ${c.horario || 'sin horario asignado'} (${c.estado})` +
      (c.silabo ? `\n  📄 Sílabo: ${c.silabo}` : '')
  );
  return `📚 Tus cursos de este periodo:\n\n${lineas.join('\n\n')}`;
}

async function enviarListaCursos(env, para, cookie) {
  const cursos = await getCursosActuales(cookie);
  await enviarWhatsApp(env, {
    to: para,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Tus cursos' },
      body: { text: 'Elige un curso para ver sus sesiones.' },
      action: {
        button: 'Ver cursos',
        sections: [
          {
            title: 'Cursos',
            rows: cursos.slice(0, 10).map((c) => ({
              id: `curso_${c.nGruCodigo}`,
              title: c.asignatura.length > 24 ? `${c.asignatura.slice(0, 21)}...` : c.asignatura,
            })),
          },
        ],
      },
    },
  });
}

async function enviarListaSesiones(env, para, cookie, nGruCodigo) {
  const [cursos, detalle] = await Promise.all([getCursosActuales(cookie), getDetalleSesionesCurso(cookie, nGruCodigo)]);
  const curso = cursos.find((c) => String(c.nGruCodigo) === String(nGruCodigo));
  const numActiva = detalle.sesiones.find((s) => s.activa)?.sesion ?? detalle.sesiones[detalle.sesiones.length - 1]?.sesion;

  // Orden descendente (más reciente primero); WhatsApp permite máx. 10 filas,
  // así que se centra la ventana en la sesión activa en vez de tomar
  // siempre las 10 con número más alto (que podrían ser puro futuro).
  const todasDescendente = [...detalle.sesiones].sort((a, b) => b.sesion - a.sesion);
  const idxActiva = Math.max(0, todasDescendente.findIndex((s) => s.sesion === numActiva));
  let inicio = Math.max(0, idxActiva - 2);
  if (inicio + 10 > todasDescendente.length) inicio = Math.max(0, todasDescendente.length - 10);
  const sesionesOrdenadas = todasDescendente.slice(inicio, inicio + 10);

  await enviarWhatsApp(env, {
    to: para,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: curso?.asignatura?.slice(0, 60) || 'Curso' },
      body: { text: 'Elige una sesión para ver su contenido.' },
      action: {
        button: 'Ver sesiones',
        sections: [
          {
            title: 'Sesiones',
            rows: sesionesOrdenadas.map((s) => {
              const etiqueta = s.sesion === numActiva ? ' (Actual)' : s.sesion === numActiva - 1 ? ' (Última)' : '';
              return { id: `sesion_${nGruCodigo}_${s.sesion}`, title: `Sesión ${s.sesion}${etiqueta}` };
            }),
          },
        ],
      },
    },
  });
}

async function manejarContenidoSesion(cookie, nGruCodigo, numeroSesion) {
  const [cursos, detalle, grabaciones] = await Promise.all([
    getCursosActuales(cookie),
    getDetalleSesionesCurso(cookie, nGruCodigo),
    getGrabaciones(cookie).catch(() => []),
  ]);
  const curso = cursos.find((c) => String(c.nGruCodigo) === String(nGruCodigo));
  const sesion = detalle.sesiones.find((s) => String(s.sesion) === String(numeroSesion));
  if (!sesion) return 'No encontré esa sesión.';
  const recursosSesion = detalle.recursos.filter((r) => String(r.sesion) === String(numeroSesion));
  const lineasRecursos = recursosSesion.map((r) =>
    r.tipo === 'Enlace' ? `• ${r.titulo}: ${r.url}` : `• ${r.titulo} (archivo — disponible en el campus virtual, sección Recursos)`
  );
  const grabacionesSesion = grabaciones.filter(
    (g) => g.asignatura.toUpperCase() === (curso?.asignatura || '').toUpperCase() && String(g.sesion) === String(numeroSesion)
  );

  const partes = [`📘 ${curso?.asignatura || 'Curso'}`];
  if (curso?.silabo) partes.push(`📄 Sílabo: ${curso.silabo}`);
  partes.push(`\n🗓️ Sesión ${sesion.sesion} (${sesion.semanaInicio}–${sesion.semanaFin}):\n${sesion.tema}`);
  if (lineasRecursos.length > 0) {
    partes.push(`\n📎 Recursos de esta sesión:\n${lineasRecursos.join('\n')}`);
  }
  if (grabacionesSesion.length > 0) {
    const lineasGrabaciones = grabacionesSesion.flatMap((g) => g.grabaciones.map((url) => `• ${g.fecha}: ${url}`));
    partes.push(`\n🎥 Grabación:\n${lineasGrabaciones.join('\n')}`);
  }
  return partes.join('\n');
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

// "DD/MM/YYYY HH:MM" -> timestamp ordenable
function fechaSesionATimestamp(fecha) {
  const [diaMes, hora] = fecha.split(' ');
  const [dia, mes, anio] = diaMes.split('/').map(Number);
  const [h, m] = (hora || '00:00').split(':').map(Number);
  return new Date(anio, mes - 1, dia, h, m).getTime();
}

async function manejarGrabaciones(cookie) {
  const sesiones = await getGrabaciones(cookie);
  const recientes = sesiones.sort((a, b) => fechaSesionATimestamp(b.fecha) - fechaSesionATimestamp(a.fecha)).slice(0, 5);
  if (recientes.length === 0) return 'No encontré grabaciones disponibles todavía.';
  const lineas = recientes.map(
    (s) => `• ${s.asignatura} — ${s.fecha}\n  ${s.grabaciones.join('\n  ')}`
  );
  return `🎥 Últimas grabaciones:\n\n${lineas.join('\n\n')}`;
}

async function manejarAnuncios(cookie) {
  const posts = await getMuro(cookie);
  const recientes = posts.slice(0, 5);
  if (recientes.length === 0) return 'No hay anuncios recientes.';
  const lineas = recientes.map((p) => `📌 *${p.titulo}* — ${p.fecha}${p.contenido ? `\n${p.contenido}` : ''}`);
  return `📢 Anuncios y eventos:\n\n${lineas.join('\n\n')}`;
}

const HANDLERS_MENU = {
  menu_horario_hoy: manejarHorarioHoy,
  menu_proxima_clase: manejarProximaClase,
  menu_cursos: manejarCursos,
  menu_notas: manejarNotas,
  menu_pagos: manejarPagos,
  menu_grabaciones: manejarGrabaciones,
  menu_anuncios: manejarAnuncios,
};

export async function manejarOpcionMenu(env, para, idOpcion) {
  if (idOpcion === 'menu_libre') {
    await enviarTexto(env, para, 'Escríbeme tu pregunta y te respondo 🙂');
    return;
  }

  if (idOpcion === 'menu_config_alertas') {
    try {
      await enviarMenuAlertas(env, para);
    } catch (error) {
      console.error('Error mostrando configuración de alertas', error);
      await enviarTexto(env, para, '⚠️ No pude cargar tu configuración de alertas ahora mismo.');
    }
    return;
  }

  if (idOpcion.startsWith('toggle_')) {
    const campo = idOpcion.slice('toggle_'.length);
    if (!ETIQUETAS_TOGGLE[campo]) {
      await enviarTexto(env, para, 'No reconocí esa alerta.');
      return;
    }
    try {
      const prefs = await obtenerPreferenciasAlertas(env);
      prefs[campo] = !prefs[campo];
      await guardarPreferenciasAlertas(env, prefs);
      await enviarMenuAlertas(env, para);
    } catch (error) {
      console.error('Error actualizando preferencias de alertas', error);
      await enviarTexto(env, para, '⚠️ No pude actualizar esa alerta ahora mismo.');
    }
    return;
  }

  if (idOpcion === 'menu_ver_curso') {
    try {
      const cookie = await loginCampus(env);
      await enviarListaCursos(env, para, cookie);
    } catch (error) {
      console.error('Error listando cursos', error);
      await enviarTexto(env, para, '⚠️ No pude consultar el campus virtual ahora mismo. Intenta de nuevo en un momento.');
    }
    return;
  }

  if (idOpcion.startsWith('curso_')) {
    const nGruCodigo = idOpcion.slice('curso_'.length);
    try {
      const cookie = await loginCampus(env);
      await enviarListaSesiones(env, para, cookie, nGruCodigo);
    } catch (error) {
      console.error('Error listando sesiones del curso', error);
      await enviarTexto(env, para, '⚠️ No pude consultar ese curso ahora mismo. Intenta de nuevo en un momento.');
    }
    return;
  }

  if (idOpcion.startsWith('sesion_')) {
    const [, nGruCodigo, numeroSesion] = idOpcion.split('_');
    try {
      const cookie = await loginCampus(env);
      const texto = await manejarContenidoSesion(cookie, nGruCodigo, numeroSesion);
      await enviarTexto(env, para, texto);
    } catch (error) {
      console.error('Error consultando contenido de la sesión', error);
      await enviarTexto(env, para, '⚠️ No pude consultar esa sesión ahora mismo. Intenta de nuevo en un momento.');
    }
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
  {
    name: 'get_contenido_curso',
    description:
      'Devuelve el sílabo (link), el temario semana a semana de todas las sesiones, y los recursos/adjuntos (enlaces a Zoom, Vimeo, plataformas externas) de un curso específico.',
    input_schema: {
      type: 'object',
      properties: {
        curso: { type: 'string', description: 'Nombre o parte del nombre del curso, ej. "Inglés" o "Programación"' },
      },
      required: ['curso'],
    },
  },
  {
    name: 'get_grabaciones',
    description: 'Devuelve las grabaciones de Zoom de las sesiones pasadas, con enlace directo. Se puede filtrar por curso.',
    input_schema: {
      type: 'object',
      properties: {
        curso: { type: 'string', description: 'Nombre o parte del nombre del curso, ej. "Inglés". Si se omite, devuelve de todos los cursos.' },
      },
    },
  },
  {
    name: 'get_anuncios',
    description: 'Devuelve los anuncios y eventos recientes publicados por la universidad en el tablero del campus.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function ejecutarHerramienta(cookie, nombre, input) {
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
    case 'get_contenido_curso': {
      const cursos = await getCursosActuales(cookie);
      const curso = cursos.find((c) => c.asignatura.toUpperCase().includes((input?.curso || '').toUpperCase()));
      if (!curso) return { error: `No encontré ningún curso que coincida con "${input?.curso}"` };
      const detalle = await getDetalleSesionesCurso(cookie, curso.nGruCodigo);
      return { curso: curso.asignatura, silabo: curso.silabo, ...detalle };
    }
    case 'get_grabaciones': {
      const sesiones = await getGrabaciones(cookie);
      if (!input?.curso) return sesiones;
      return sesiones.filter((s) => s.asignatura.toUpperCase().includes(input.curso.toUpperCase()));
    }
    case 'get_anuncios':
      return getMuro(cookie);
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
          const resultado = await ejecutarHerramienta(cookie, bloque.name, bloque.input);
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
