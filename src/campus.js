const BASE = 'https://virtual.autonoma.edu.pe';

function extraerCampoOculto(html, nombre) {
  const regex = new RegExp(`id="${nombre}"[^>]*value="([^"]*)"`);
  const match = html.match(regex);
  return match ? match[1] : '';
}

function extraerCookie(respuesta, nombre) {
  const setCookie = respuesta.headers.get('set-cookie') || '';
  const match = setCookie.match(new RegExp(`${nombre}=([^;]+)`));
  return match ? match[1] : null;
}

// Reproduce el login de ASP.NET Forms Authentication: primero pide la
// pagina para obtener __VIEWSTATE/__EVENTVALIDATION (tokens de un solo uso
// atados a la sesion), luego postea usuario/contrasena con esos tokens.
export async function loginCampus(env) {
  const paginaLogin = await fetch(`${BASE}/Campus/Login.aspx`, { redirect: 'manual' });
  const html = await paginaLogin.text();
  const sessionId = extraerCookie(paginaLogin, 'ASP.NET_SessionId');
  if (!sessionId) {
    throw new Error('No se pudo obtener ASP.NET_SessionId del campus virtual');
  }

  const viewState = extraerCampoOculto(html, '__VIEWSTATE');
  const viewStateGenerator = extraerCampoOculto(html, '__VIEWSTATEGENERATOR');
  const eventValidation = extraerCampoOculto(html, '__EVENTVALIDATION');

  const body = new URLSearchParams({
    __EVENTTARGET: '',
    __EVENTARGUMENT: '',
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: viewStateGenerator,
    __EVENTVALIDATION: eventValidation,
    txtUsuario: env.CAMPUS_USUARIO,
    txtPassword: env.CAMPUS_PASSWORD,
    btn_ingresar: 'Ingresar',
  });

  const respuestaLogin = await fetch(`${BASE}/Campus/Login.aspx`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `ASP.NET_SessionId=${sessionId}`,
    },
    body: body.toString(),
  });

  const authCookie = extraerCookie(respuestaLogin, '.ASPXFORMSAUTH');
  if (!authCookie) {
    throw new Error('Login al campus virtual fallo: credenciales invalidas o VIEWSTATE expirado');
  }

  return `ASP.NET_SessionId=${sessionId}; .ASPXFORMSAUTH=${authCookie}`;
}

// Los PageMethods de ASP.NET devuelven {"d": "<json-string>"} - el valor de
// "d" es a su vez un JSON serializado como texto, hay que parsearlo dos veces.
async function llamarMetodo(cookie, ruta, payload = {}) {
  const respuesta = await fetch(`${BASE}${ruta}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookie,
    },
    body: JSON.stringify(payload),
  });

  if (!respuesta.ok) {
    throw new Error(`Campus virtual respondio ${respuesta.status} en ${ruta}`);
  }

  const datos = await respuesta.json();
  return JSON.parse(datos.d);
}

function quitarHtml(texto = '') {
  return texto.replace(/<[^>]+>/g, '').trim();
}

// El endpoint real trae descripciones enormes en HTML (metodologia, logro,
// informacionAsignatura) que no aportan nada util al chatbot y solo suman
// tokens. Se devuelve una version resumida con lo que realmente se consulta.
export async function getCursosActuales(cookie) {
  const cursos = await llamarMetodo(cookie, '/Campus/Default.aspx/Alu_ObtenerCursosActuales', {});
  return cursos.map((c) => ({
    asignatura: c.asignatura,
    docente: [c.docenteNombre, c.docenteApellido].filter(Boolean).join(' '),
    correoDocente: c.correoDocente || null,
    horario: (c.arrayHorarioDesignv2 || []).map((h) => quitarHtml(h.properties?.html)).join(' · '),
    fechaInicioCurso: c.fechaInicioCurso,
    fechaFinCurso: c.fechaFinCurso,
    estado: quitarHtml(c.cValidacionFechas),
    creditos: c.creditos,
    modalidad: c.modalidad,
    silabo: c.cSilabo ? `https://virtual.autonoma.edu.pe${c.cSilabo}` : null,
  }));
}

export async function getHorarioDetallado(cookie) {
  const datos = await llamarMetodo(
    cookie,
    '/CampusVirtual/ua/Alumno/MisCursos/Alu_HorarioClase.aspx/Alu_ObtenerHorarioClase',
    { cAsignatura: '', cPerCodigo: '', cTablas: 'HORARIO_DETALLADO,HORARIO_DE_HOY,HORARIO_ACTUAL', nPerAluRegCodigo: 0 }
  );
  return datos.HORARIO_DETALLADO || [];
}

function resumirSesion(s) {
  return {
    asignatura: s.Asignatura,
    fecha: s.fechaInicioReunion,
    enlace: s.start_url,
  };
}

export async function getProximasSesiones(cookie) {
  const datos = await llamarMetodo(cookie, '/Campus/Default.aspx/obtenerSesionesVirtualesHoyProxima', {});
  return {
    hoy: datos.hoy,
    sesionesHoy: (datos.sesionesHoy || []).map(resumirSesion),
    sesionesProximas: (datos.sesioneProx || []).map(resumirSesion),
  };
}

export async function getPagosPendientes(cookie) {
  const datos = await llamarMetodo(cookie, '/Campus/ua/MisFinanzas/Camp_Virt_PagosPendientes.aspx/Alu_ObtenerPagosPendientes', { cPerCodigo: '' });
  return datos.DETALLE_PENDIENTE_PAGO || [];
}

// nPerAluRegCodigo identifica la matricula del periodo activo; se resuelve
// en vivo (no se hardcodea) porque cambia entre periodos academicos.
export async function getRegistroActual(cookie) {
  const registros = await llamarMetodo(cookie, '/Campus/ua/Tablero/Perfil/Camp_Virt_Perfil.aspx/USP_CAMP_ObtenerCurriculas_By_cPercodigo', { cAcion: 2 });
  return registros[0]?.nPerAluRegCodigo;
}

export async function getAvanceCarrera(cookie, nPerAluRegCodigo) {
  const datos = await llamarMetodo(cookie, '/campus/ua/Tablero/Perfil/Camp_Virt_Perfil.aspx/ObtenerDataAvanceCarrera', {
    cPerCodigo: '',
    cTablas: 'Malla_Curricular,Malla_Curricular_grafAvanceCarrera',
    nPerAluRegCodigo,
  });
  const cursos = (datos.Malla_Curricular || []).map((c) => ({
    asignatura: c.cAsignatura,
    ciclo: c.cCiclo,
    estado: c.Estado,
    nota: c.Nota || null,
    periodo: c.Periodo || null,
    creditos: c.nNroCredito,
  }));
  const avance = datos.grafAvanceCarrera?.[0]
    ? {
        creditosAprobados: datos.grafAvanceCarrera[0].totalCreditosAprobados,
        creditosTotales: datos.grafAvanceCarrera[0].totalCreditos,
      }
    : null;
  return { cursos, avance };
}
