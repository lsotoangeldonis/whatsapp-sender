// Preferencias de alertas, guardadas en Workers KV (mismo namespace que
// el horario). Como el proyecto es de un solo usuario, no se guardan por
// número de teléfono: es una sola configuración global.
const CLAVE_KV = 'alertas';

const POR_DEFECTO = {
  resumenHoy: true, // cron 07:00, resumen de las clases de hoy
  avisoManana: true, // cron 21:00, aviso de las clases de mañana
  proximaClase: true, // aviso ~15 min antes de que empiece una sesión
  proximoPago: true, // aviso cuando una cuota vence en 3 días o menos
};

export async function obtenerPreferenciasAlertas(env) {
  const datos = await env.HORARIO_KV.get(CLAVE_KV, 'json');
  return { ...POR_DEFECTO, ...datos };
}

export async function guardarPreferenciasAlertas(env, prefs) {
  await env.HORARIO_KV.put(CLAVE_KV, JSON.stringify(prefs));
}
