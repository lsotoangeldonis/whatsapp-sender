// Helpers de fecha compartidos entre index.js (recordatorios/alertas) y
// chatbot.js (horario semana/mes). Todo en hora Lima (UTC-5 fijo, sin
// horario de verano).
export const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
export const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
export const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000;

export function fechaISOLima(offsetDiasMs = 0) {
  return new Date(Date.now() - LIMA_OFFSET_MS + offsetDiasMs).toISOString().slice(0, 10);
}

export function fechaLegible(fechaISO, prefijo) {
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  const diaSemana = DIAS_SEMANA[fecha.getUTCDay()];
  return `${prefijo} ${diaSemana} ${dia} de ${MESES[mes - 1]}`;
}

// DD/MM/YYYY (formato del campus) -> YYYY-MM-DD
export function fechaISODesdeCampus(cFecha) {
  const [dia, mes, anio] = cFecha.split('/');
  return `${anio}-${mes}-${dia}`;
}

// El campus no manda un campo "tipo" explícito: cAmbiente vale "Asesoría"
// para las asesorías y "ZOOM"/"Zoom" para la clase en vivo.
export function tipoSesion(cAmbiente) {
  return (cAmbiente || '').toLowerCase().includes('asesor') ? 'Asesoría' : 'EN VIVO';
}
