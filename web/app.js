"use strict";

const PASOS = ["Clip", "Mascara", "Motor y calidad", "Procesar"];
const state = {
  step: 0,
  theme: "dark",
  clips: [],
  clipReferencia: null,
  frameImg: null,
  frameW: 1280, frameH: 720,
  duracionSeg: 0,
  tool: "brush",
  altErasing: false,
  brushSize: 28,
  hardness: 100,
  opacity: 100,
  angleFine: 0,
  zoom: {mascara: 1, motor: 1},
  pan: {mascara: {x: 0, y: 0}},
  fitScale: {mascara: 1},
  history: [], historyIndex: -1,
  maskBaseSnapshot: null,
  motor: "opencv",
  sigma: 15,
  calidad: "bitrate",
  velocidad: "Rapido",
  resolucion: "Original",
  renderizando: false,
  isPainting: false, isPanning: false, lastPt: null, panStart: null,
  debounceTimer: null,
};

/* ---------------- API bridge (real pywebview or mock for browser preview) ---------------- */
const mockFrameDataUrl = (() => {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 360;
  const ctx = c.getContext("2d");
  const cols = ["#e5484d", "#35c58a", "#f5d90a", "#2f6fed", "#e34ba9", "#0ac5c5"];
  cols.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect(i * (640 / 6), 0, 640 / 6, 360); });
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(40, 320); ctx.lineTo(560, 60); ctx.stroke();
  return c.toDataURL("image/png");
})();

const mockApi = {
  elegir_clips: async () => (["C:/videos/clip_prueba.mp4"]),
  obtener_frame_y_metadata: async (ruta) => ({
    frame_b64: mockFrameDataUrl, ancho: 640, alto: 360, duracion_seg: 137,
    metadata: mockApi._metaPorRuta(ruta),
  }),
  obtener_metadata_clip: async (ruta) => ({metadata: mockApi._metaPorRuta(ruta)}),
  _metaPorRuta: (ruta) => ({
    nombre_archivo: (ruta || "clip.mp4").split(/[\\/]/).pop(),
    marca: "Sony", modelo: "ILCE-7M3", lente: "FE 24-70mm F2.8 GM", iso: "800", perfil_color: "S-Log3",
    resolucion: "3840x2160", duracion: "00:02:17", fotogramas: 3425, bits_color: "10-bit", formato: "QuickTime / MOV",
    fps: 25, codec_video: "H.264", pixel_format: "yuv420p", bitrate: "45.2 Mbps", peso: "742 MB",
    contenedor: "QuickTime / MOV", codec_audio: "AAC", audio_canales: 2, audio_sample_rate: "48 kHz",
    fecha: "2026-07-25T04:35:25.000000Z",
  }),
  render_preview: async (motorId, maskB64, sigma) => ({antes_b64: mockFrameDataUrl, despues_b64: mockFrameDataUrl}),
  obtener_frame_en: async (ruta, segundo) => ({ok: true}),
  procesar_todo: async (payload) => {
    mockApi._progreso = {
      completados: 0, total: payload.clips.length, por_clip: payload.clips.map(() => 0),
      rutas_salida: payload.clips.map(() => null), logs: [], terminado: false,
    };
    let n = 0;
    const avanzar = () => {
      n++;
      mockApi._progreso.completados = n;
      mockApi._progreso.por_clip = mockApi._progreso.por_clip.map((_, i) => (i < n ? 1 : 0));
      mockApi._progreso.rutas_salida[n - 1] = `C:/videos/Clipxel/clip_${n}.mp4`;
      mockApi._progreso.logs.push({mensaje: `OK: clip_${n}.mp4 -> clip_${n}.mp4`, ok: true});
      if (n < payload.clips.length) setTimeout(avanzar, 700);
      else mockApi._progreso.terminado = true;
    };
    setTimeout(avanzar, 700);
    return {ok: true};
  },
  mostrar_en_carpeta: async (ruta) => ({ok: false, error: "Modo de prueba en navegador: no se puede abrir el explorador de archivos aca."}),
  cancelar_procesamiento: async () => { if (mockApi._progreso) mockApi._progreso.terminado = true; return {ok: true}; },
  cargar_configuracion: async () => ({ok: true, settings: {}}),
  guardar_configuracion: async () => ({ok: true}),
  obtener_estado_actualizacion: async () => ({hay_actualizacion: false}),
  instalar_actualizacion: async () => ({ok: false, error: "Modo de prueba en navegador: la auto-instalacion solo funciona en la app real."}),
  confirmar_actualizacion: async () => ({ok: false, error: "Modo de prueba en navegador."}),
  _carpetaSalidaMock: null,
  obtener_carpeta_salida: async () => ({carpeta: mockApi._carpetaSalidaMock}),
  elegir_carpeta_salida: async () => {
    mockApi._carpetaSalidaMock = "C:/Users/Usuario/Videos/Exportados (simulado)";
    return {carpeta: mockApi._carpetaSalidaMock};
  },
  restablecer_carpeta_salida: async () => { mockApi._carpetaSalidaMock = null; return {carpeta: null}; },
  mis_plantillas: async () => ({ok: true, plantillas: []}),
  obtener_plantilla: async () => ({ok: false, error: "Modo de prueba en navegador."}),
  guardar_plantilla: async () => ({ok: false, error: "Modo de prueba en navegador."}),
  borrar_plantilla: async () => ({ok: false, error: "Modo de prueba en navegador."}),
};

// nota: el flujo real consulta el progreso por fetch('/progreso') servido por el mismo
// servidor Python (ver webview_app.py), no por api.obtener_progreso -- eso evita un pedido
// entre origenes distintos que resulto poco confiable en pywebview+WinForms+WebView2.
let api = (window.pywebview && window.pywebview.api) ? window.pywebview.api : mockApi;
window.addEventListener("pywebviewready", () => {
  api = window.pywebview.api;
  revisarActualizacion();
  if (typeof cargarConfiguracionInicial === "function") cargarConfiguracionInicial();
});
// En modo de prueba en navegador no hay evento pywebviewready: cargamos
// la configuracion (local) ya mismo.
if (api === mockApi && typeof cargarConfiguracionInicial === "function") cargarConfiguracionInicial();

/* ---------------- Campanita de actualizaciones ---------------- */
let _actualizacionListaMostrada = false;
const actualizacionListaOverlay = document.getElementById("actualizacionListaOverlay");

async function revisarActualizacion() {
  try {
    const estado = await api.obtener_estado_actualizacion();
    if (estado && estado.hay_actualizacion) {
      document.getElementById("notifDot").classList.add("visible");
      document.getElementById("notifEmpty").style.display = "none";
      document.getElementById("notifUpdate").style.display = "block";
      document.getElementById("updateVersion").textContent = estado.version_nueva;
      const changelogEl = document.getElementById("updateChangelog");
      if (changelogEl) {
        if (estado.changelog) {
          changelogEl.textContent = estado.changelog;
          changelogEl.style.display = "block";
        } else {
          changelogEl.style.display = "none";
        }
      }
    }
    // El instalador se descarga solo en segundo plano, pero nunca cierra
    // la app sin avisar -- cuando queda listo, se le pregunta al usuario
    // si quiere reiniciar ahora o mas tarde. No se vuelve a mostrar en la
    // misma sesion si ya eligio "Mas tarde".
    if (estado && estado.listo_para_instalar && !estado.instalando && !_actualizacionListaMostrada
        && !actualizacionListaOverlay.classList.contains("open")) {
      _actualizacionListaMostrada = true;
      document.getElementById("alVersion").textContent = estado.version_nueva || "";
      document.getElementById("alMsg").textContent = "";
      actualizacionListaOverlay.classList.add("open");
    }
  } catch (err) {
    // sin internet o api no disponible todavia: no molestamos
  }
}
setTimeout(revisarActualizacion, 4000);
setInterval(revisarActualizacion, 30000);

document.getElementById("alMasTarde").addEventListener("click", () => {
  actualizacionListaOverlay.classList.remove("open");
});
document.getElementById("alReiniciarAhora").addEventListener("click", async () => {
  const btn = document.getElementById("alReiniciarAhora");
  const msg = document.getElementById("alMsg");
  btn.disabled = true;
  msg.textContent = "Cerrando para actualizar...";
  msg.className = "licencia-msg";
  const resultado = await api.confirmar_actualizacion().catch((err) => ({ok: false, error: String(err)}));
  if (!resultado.ok) {
    btn.disabled = false;
    msg.textContent = resultado.error || "No se pudo actualizar.";
    msg.className = "licencia-msg err";
  }
});

const notifPop = document.getElementById("notifPop");
document.getElementById("btnNotif").addEventListener("click", (e) => {
  e.stopPropagation();
  notifPop.classList.toggle("open");
});
document.addEventListener("click", (e) => {
  if (notifPop.classList.contains("open") && !notifPop.contains(e.target) && e.target.id !== "btnNotif") {
    notifPop.classList.remove("open");
  }
});

document.getElementById("btnActualizar").addEventListener("click", async () => {
  const btn = document.getElementById("btnActualizar");
  const estado = document.getElementById("updateStatus");
  btn.disabled = true;
  estado.textContent = "Descargando...";
  const resultado = await api.instalar_actualizacion().catch((err) => ({ok: false, error: String(err)}));
  if (resultado.ok) {
    estado.textContent = "Instalando, la app se va a reiniciar sola...";
  } else {
    btn.disabled = false;
    estado.textContent = resultado.error || "No se pudo actualizar.";
  }
});

function formatearFechaRelativa(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" });
  } catch (e) {
    return iso;
  }
}

/* ---------------- Plantillas (mascaras guardadas en esta PC) ---------------- */
const guardarPlantillaOverlay = document.getElementById("guardarPlantillaOverlay");
const plantillaNombreInput = document.getElementById("plantillaNombreInput");
const guardarPlantillaMsg = document.getElementById("guardarPlantillaMsg");
const plantillasOverlay = document.getElementById("plantillasOverlay");
const plantillasStatus = document.getElementById("plantillasStatus");
const plantillasList = document.getElementById("plantillasList");

function abrirGuardarPlantilla() {
  if (!hayMascara()) {
    alert("Pintá una máscara antes de guardarla como plantilla.");
    return;
  }
  const meta = _metaCache[state.clipReferencia] && _metaCache[state.clipReferencia].metadata;
  plantillaNombreInput.value = meta && meta.modelo ? `${meta.marca || ""} ${meta.modelo}`.trim() : "";
  guardarPlantillaMsg.textContent = "";
  guardarPlantillaMsg.className = "licencia-msg";
  guardarPlantillaOverlay.classList.add("open");
  plantillaNombreInput.focus();
}
document.getElementById("btnGuardarPlantilla").addEventListener("click", abrirGuardarPlantilla);
document.getElementById("guardarPlantillaClose").addEventListener("click", () => guardarPlantillaOverlay.classList.remove("open"));
document.getElementById("guardarPlantillaCancelar").addEventListener("click", () => guardarPlantillaOverlay.classList.remove("open"));
guardarPlantillaOverlay.addEventListener("click", (e) => { if (e.target === guardarPlantillaOverlay) guardarPlantillaOverlay.classList.remove("open"); });

document.getElementById("guardarPlantillaConfirmar").addEventListener("click", async () => {
  const nombre = plantillaNombreInput.value.trim();
  if (!nombre) {
    guardarPlantillaMsg.textContent = "Ponele un nombre a la plantilla.";
    guardarPlantillaMsg.className = "licencia-msg err";
    return;
  }
  const btn = document.getElementById("guardarPlantillaConfirmar");
  btn.disabled = true;
  guardarPlantillaMsg.textContent = "Guardando...";
  guardarPlantillaMsg.className = "licencia-msg";

  const meta = _metaCache[state.clipReferencia] && _metaCache[state.clipReferencia].metadata;
  const resultado = await api.guardar_plantilla(
    nombre, cnvMask.toDataURL(),
    meta ? meta.marca : null, meta ? meta.modelo : null,
    state.frameW, state.frameH, state.motor, state.sigma
  ).catch((err) => ({ ok: false, error: String(err) }));
  btn.disabled = false;

  if (resultado.ok) {
    guardarPlantillaMsg.textContent = "¡Guardada!";
    guardarPlantillaMsg.className = "licencia-msg ok";
    setTimeout(() => guardarPlantillaOverlay.classList.remove("open"), 1000);
  } else {
    guardarPlantillaMsg.textContent = resultado.error || "No se pudo guardar la plantilla.";
    guardarPlantillaMsg.className = "licencia-msg err";
  }
});

async function abrirPlantillas() {
  plantillasOverlay.classList.add("open");
  plantillasStatus.textContent = "Cargando...";
  plantillasList.innerHTML = "";

  const resultado = await api.mis_plantillas().catch((err) => ({ ok: false, error: String(err) }));
  if (!resultado.ok) {
    plantillasStatus.textContent = resultado.error || "No se pudo cargar la lista.";
    return;
  }

  plantillasStatus.textContent = "";
  if (!resultado.plantillas.length) {
    plantillasStatus.textContent = "Todavía no guardaste ninguna plantilla.";
    return;
  }

  resultado.plantillas.forEach((p) => {
    const row = document.createElement("div");
    row.className = "plantilla-row";
    const camara = p.camara_marca || p.camara_modelo ? `${p.camara_marca || ""} ${p.camara_modelo || ""}`.trim() : "Sin cámara asociada";
    row.innerHTML = `
      <div>
        <div class="plantilla-nombre">${p.nombre}</div>
        <div class="plantilla-detalle">${camara} · ${formatearFechaRelativa(p.updated_at)}</div>
      </div>
      <div>
        <button class="dispositivo-cerrar plantilla-borrar" data-id="${p.id}">Borrar</button>
      </div>
    `;
    row.addEventListener("click", async (e) => {
      if (e.target.closest(".plantilla-borrar")) return;
      const r = await api.obtener_plantilla(p.id).catch((err) => ({ ok: false, error: String(err) }));
      if (r.ok) {
        cargarMascaraEscalada(r.plantilla.mascara_b64);
        plantillasOverlay.classList.remove("open");
      } else {
        alert(r.error || "No se pudo cargar la plantilla.");
      }
    });
    plantillasList.appendChild(row);
  });

  plantillasList.querySelectorAll(".plantilla-borrar").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("¿Borrar esta plantilla?")) return;
      btn.disabled = true;
      btn.textContent = "...";
      const r = await api.borrar_plantilla(btn.dataset.id).catch((err) => ({ ok: false, error: String(err) }));
      if (r.ok) {
        abrirPlantillas();
      } else {
        btn.disabled = false;
        btn.textContent = "Borrar";
        alert(r.error || "No se pudo borrar la plantilla.");
      }
    });
  });
}
document.getElementById("btnMisPlantillas").addEventListener("click", abrirPlantillas);
document.getElementById("plantillasClose").addEventListener("click", () => plantillasOverlay.classList.remove("open"));
plantillasOverlay.addEventListener("click", (e) => { if (e.target === plantillasOverlay) plantillasOverlay.classList.remove("open"); });

/* ---------------- Topbar: pasos + tema ---------------- */
function renderSteps() {
  const cont = document.getElementById("steps");
  cont.innerHTML = "";
  PASOS.forEach((nombre, i) => {
    const pill = document.createElement("div");
    pill.className = "step-pill" + (i === state.step ? " active" : "") + (i < state.step ? " done" : "");
    pill.innerHTML = `<span class="num">${i < state.step ? "" : i + 1}</span><span>${nombre}</span>`;
    cont.appendChild(pill);
  });
}

document.getElementById("themeToggle").addEventListener("click", () => {
  state.theme = state.theme === "light" ? "dark" : "light";
  document.body.setAttribute("data-theme", state.theme);
  guardarConfigDebounced();
});

/* ---------------- Configuracion sincronizada con la cuenta ---------------- */
let configSaveTimer = null;
let configCargando = false;

function recolectarConfiguracion() {
  return {
    theme: state.theme, brushSize: state.brushSize, hardness: state.hardness, opacity: state.opacity,
    motor: state.motor, calidad: state.calidad, velocidad: state.velocidad, resolucion: state.resolucion,
  };
}

function guardarConfigDebounced() {
  if (configCargando) return; // no reescribir mientras estamos aplicando lo que bajamos
  clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(() => {
    api.guardar_configuracion(recolectarConfiguracion()).catch(() => {});
  }, 1200);
}

async function cargarConfiguracionInicial() {
  const resultado = await api.cargar_configuracion().catch(() => ({ ok: false }));
  if (!resultado.ok || !resultado.settings || !Object.keys(resultado.settings).length) return;
  configCargando = true;
  const s = resultado.settings;

  if (s.theme) { state.theme = s.theme; document.body.setAttribute("data-theme", state.theme); }
  if (typeof s.brushSize === "number") setBrushSize(s.brushSize);
  if (typeof s.hardness === "number") setHardness(s.hardness);
  if (typeof s.opacity === "number") setOpacity(s.opacity);
  if (s.calidad) {
    state.calidad = s.calidad;
    const radio = document.querySelector(`input[name="calidad"][value="${s.calidad}"]`);
    if (radio) radio.checked = true;
  }
  if (s.resolucion) {
    state.resolucion = s.resolucion;
    const sel = document.getElementById("selectResolucion");
    if (sel) sel.value = s.resolucion;
  }
  if (s.velocidad) state.velocidad = s.velocidad;
  if (s.motor) {
    state.motor = s.motor;
    document.querySelectorAll(".engine-card").forEach((card) => {
      card.classList.toggle("selected", card.dataset.engine === s.motor);
    });
    if (typeof actualizarVisibilidadSigma === "function") actualizarVisibilidadSigma();
  }

  configCargando = false;
}

/* ---------------- Navegacion entre pasos ---------------- */
function mostrarPaso(nuevo) {
  state.step = nuevo;
  document.querySelectorAll(".panel").forEach(p => {
    p.classList.toggle("active", Number(p.dataset.step) === nuevo);
  });
  renderSteps();
  document.getElementById("btnAtras").disabled = nuevo === 0;
  document.getElementById("btnSiguiente").textContent = nuevo === PASOS.length - 1 ? "Procesar" : "Siguiente";
  document.getElementById("navInfo").textContent = "";
  if (nuevo === 1) {
    if (!state.frameImg) document.getElementById("viewportLoading").style.display = "flex";
    setTimeout(fitCanvasToViewport, 30);
  } else videoFrame.pause();
  if (nuevo === 2) actualizarPreview("motor");
  if (nuevo === 3 && !_pollTimer) {
    // recien se entra al paso, todavia no se apreto "Procesar": no mostrar
    // el anillo de progreso (se veria como si ya estuviera renderizando).
    document.getElementById("antesDeProcesar").style.display = "flex";
    document.getElementById("estadoProcesando").style.display = "none";
  }
}

document.getElementById("btnAtras").addEventListener("click", () => {
  if (state.renderizando) return;
  if (state.step > 0) mostrarPaso(state.step - 1);
});

document.getElementById("btnSiguiente").addEventListener("click", () => {
  const info = document.getElementById("navInfo");
  if (state.step === 0 && state.clips.length === 0) { info.textContent = "Carga al menos un clip primero"; info.classList.add("warn"); return; }
  if (state.step === 1 && !hayMascara()) { info.textContent = "Pinta o carga una mascara primero"; info.classList.add("warn"); return; }
  info.classList.remove("warn");
  if (state.step < PASOS.length - 1) mostrarPaso(state.step + 1);
  else procesarTodo();
});

/* ---------------- Paso 1: Clip ---------------- */
let _clipSeleccionado = 0;
const _metaCache = {};

function renderizarListaClips() {
  document.getElementById("lblClips").textContent = state.clips.length ? `${state.clips.length} clip(s) cargado(s)` : "Ningun clip cargado";
  const list = document.getElementById("clipList");
  list.innerHTML = "";
  state.clips.forEach((ruta, i) => {
    const row = document.createElement("div");
    row.className = "clip-row" + (i === _clipSeleccionado ? " selected" : "");
    const nombre = ruta.split(/[\\/]/).pop();
    row.innerHTML = `<span class="name">${nombre}</span><div class="bar"><div style="width:0%"></div></div><button class="clip-remove" data-i="${i}" title="Quitar">&times;</button>`;
    row.addEventListener("click", () => mostrarInfoClip(i));
    list.appendChild(row);
  });
  list.querySelectorAll(".clip-remove").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      quitarClip(Number(btn.dataset.i));
    });
  });
}

async function mostrarInfoClip(indice) {
  const ruta = state.clips[indice];
  if (!ruta) return;
  _clipSeleccionado = indice;
  document.querySelectorAll("#clipList .clip-row").forEach((row, i) => {
    row.classList.toggle("selected", i === indice);
  });
  if (!_metaCache[ruta]) {
    document.getElementById("metaFields").innerHTML = `<div class="meta-field"><span class="k">Leyendo datos del archivo...</span></div>`;
    _metaCache[ruta] = await api.obtener_metadata_clip(ruta);
  }
  // si mientras se esperaba la respuesta el usuario ya clickeo otro clip,
  // no pisar su info con la de este pedido que llego tarde
  if (_clipSeleccionado !== indice) return;
  mostrarMetadata(_metaCache[ruta].metadata);
}

async function quitarClip(indice) {
  const ruta = state.clips[indice];
  delete _metaCache[ruta];
  state.clips.splice(indice, 1);
  if (_clipSeleccionado >= state.clips.length) _clipSeleccionado = Math.max(0, state.clips.length - 1);
  renderizarListaClips();
  renderizarSelectorReferencia();
  if (!state.clips.length) {
    state.frameImg = null;
    state.clipReferencia = null;
    videoFrame.removeAttribute("src");
    document.getElementById("brandBadge").querySelector("span").textContent = "Sin datos de camara";
    document.getElementById("metaFields").innerHTML = "";
    return;
  }
  if (ruta === state.clipReferencia) {
    // el clip que se uso como referencia para pintar la mascara se quito
    // de la lista -- cae al primero que quede, como al cargar por primera vez.
    const datos = await api.obtener_frame_y_metadata(state.clips[0]);
    state.clipReferencia = state.clips[0];
    state.duracionSeg = datos.duracion_seg || 0;
    cargarFrameMuestra(datos);
    _metaCache[state.clips[0]] = {metadata: datos.metadata};
  }
  mostrarInfoClip(_clipSeleccionado);
}

async function establecerClips(archivos) {
  if (!archivos || !archivos.length) return;
  state.clips = archivos;
  _clipSeleccionado = 0;
  state.frameImg = null; // hasta que cargarFrameMuestra confirme el nuevo cuadro, el visor de Mascara no tiene nada listo para mostrar
  renderizarListaClips();
  renderizarSelectorReferencia();
  document.getElementById("metaFields").innerHTML = `<div class="meta-field"><span class="k">Leyendo datos del archivo...</span></div>`;
  // se prende ya (no recien cuando termine de leer los datos) para que si el
  // usuario pasa al paso Mascara mientras esto todavia esta cargando, no se
  // encuentre con la pantalla en negro sin ningun indicio de que esta
  // cargando.
  document.getElementById("viewportLoading").style.display = "flex";
  const datos = await api.obtener_frame_y_metadata(archivos[0]);
  state.clipReferencia = archivos[0];
  state.duracionSeg = datos.duracion_seg || 0;
  cargarFrameMuestra(datos);
  _metaCache[archivos[0]] = {metadata: datos.metadata};
  mostrarInfoClip(0);
}

/* ---------------- Elegir que clip usar de referencia para pintar (paso Mascara) ---------------- */
// Algunos videos de la misma camara pueden no mostrar bien el defecto --
// esto deja recorrer/reproducir cualquier clip de la lista para encontrar
// uno donde se note mejor, sin perder la mascara ya pintada.
function renderizarSelectorReferencia() {
  const sel = document.getElementById("selectClipReferencia");
  sel.innerHTML = state.clips.map((ruta) => {
    const nombre = ruta.split(/[\\/]/).pop();
    return `<option value="${ruta}">${nombre}</option>`;
  }).join("");
  if (state.clipReferencia) sel.value = state.clipReferencia;
}

async function cambiarClipReferencia(ruta) {
  if (!ruta || ruta === state.clipReferencia) return;
  document.getElementById("viewportLoading").style.display = "flex";
  const datos = await api.obtener_frame_y_metadata(ruta);
  state.clipReferencia = ruta;
  state.duracionSeg = datos.duracion_seg || 0;
  cargarFrameMuestra(datos);
  if (!_metaCache[ruta]) _metaCache[ruta] = {metadata: datos.metadata};
  document.getElementById("selectClipReferencia").value = ruta;
}

document.getElementById("selectClipReferencia").addEventListener("change", (e) => {
  cambiarClipReferencia(e.target.value);
});

function formatoTiempo(seg) {
  seg = Math.max(0, Math.round(seg || 0));
  const m = Math.floor(seg / 60), s = seg % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

document.getElementById("btnCargarClips").addEventListener("click", async () => {
  const btnCargar = document.getElementById("btnCargarClips");
  btnCargar.disabled = true;
  try {
    const archivos = await api.elegir_clips();
    if (archivos && archivos.length) establecerClips(archivos);
  } finally {
    btnCargar.disabled = false;
  }
});

// El navegador nunca expone la ruta real de un archivo soltado (por seguridad),
// asi que la extraccion de rutas no se hace aca: Python la intercepta via el
// bridge nativo de pywebview (window.dom, ver webview_app.py) y llama a
// window.agregarClipsDesdeDrop con las rutas ya resueltas. Aca solo se maneja
// el feedback visual de "estas arrastrando algo arriba".
const zonaClip = document.querySelector(".panel-clip");
document.addEventListener("dragenter", (e) => { e.preventDefault(); zonaClip.classList.add("dragover"); });
document.addEventListener("dragover", (e) => { e.preventDefault(); zonaClip.classList.add("dragover"); });
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) zonaClip.classList.remove("dragover"); });
document.addEventListener("drop", (e) => { e.preventDefault(); zonaClip.classList.remove("dragover"); });

window.agregarClipsDesdeDrop = function (rutas) {
  if (rutas && rutas.length) establecerClips(rutas);
};

function mostrarMetadata(meta) {
  const badge = document.getElementById("brandBadge");
  const span = badge.querySelector("span");
  span.textContent = (meta && meta.marca) ? meta.marca : "Marca no detectada";

  const grupos = [
    {titulo: "Archivo", campos: [["Nombre del archivo", "nombre_archivo"], ["Duracion", "duracion"],
      ["Fotogramas", "fotogramas"], ["Bits de color", "bits_color"], ["Fecha y hora de grabacion", "fecha"],
      ["Formato", "formato"]]},
    {titulo: "Camara y lente", campos: [["Modelo", "modelo"], ["Lente", "lente"], ["ISO", "iso"],
      ["Perfil de color", "perfil_color"], ["Espacio de color", "espacio_color"], ["Timecode", "timecode"]]},
    {titulo: "Codificacion", campos: [["Resolucion", "resolucion"], ["FPS", "fps"],
      ["Codec de video", "codec_video"], ["Formato de pixel", "pixel_format"], ["Bitrate", "bitrate"], ["Peso", "peso"],
      ["Contenedor", "contenedor"], ["Codec de audio", "codec_audio"], ["Canales de audio", "audio_canales"], ["Frecuencia de audio", "audio_sample_rate"]]},
  ];
  const fields = document.getElementById("metaFields");
  fields.innerHTML = "";
  let huboAlgo = false;
  grupos.forEach(grupo => {
    const presentes = grupo.campos.filter(([, key]) => meta && meta[key]);
    if (!presentes.length) return;
    huboAlgo = true;
    const titulo = document.createElement("div");
    titulo.className = "section-title";
    titulo.style.marginTop = "10px";
    titulo.textContent = grupo.titulo;
    fields.appendChild(titulo);
    presentes.forEach(([label, key]) => {
      const row = document.createElement("div");
      row.className = "meta-field";
      row.innerHTML = `<span class="k">${label}</span><span class="v">${meta[key]}</span>`;
      fields.appendChild(row);
    });
  });
  if (!huboAlgo) fields.innerHTML = `<div class="meta-field"><span class="k">El archivo no trae datos tecnicos embebidos.</span></div>`;
}

/* ---------------- Editor de mascara: video real + canvas de mascara, pincel, zoom, pan, historial ---------------- */
const videoFrame = document.getElementById("videoFrame");
const cnvMask = document.getElementById("cnvMask");
const ctxMask = cnvMask.getContext("2d");
const viewport = document.getElementById("viewportMascara");
const stage = document.getElementById("stageMascara");
const brushCursor = document.getElementById("brushCursor");

function cargarFrameMuestra(datos) {
  // Si se esta cambiando de clip de referencia (no la primera carga) y el
  // nuevo tiene exactamente el mismo tamaño, se conserva lo ya pintado en
  // vez de perderlo -- cambiar de clip para ver donde se nota mejor el
  // defecto no deberia obligar a repintar la mascara de cero.
  const mismasDimensiones = state.frameImg && datos.ancho === state.frameW && datos.alto === state.frameH;
  const snapshotMascara = mismasDimensiones ? cnvMask.toDataURL() : null;

  state.frameW = datos.ancho; state.frameH = datos.alto;
  state.frameImg = true;
  cnvMask.width = state.frameW; cnvMask.height = state.frameH;
  ctxMask.clearRect(0, 0, state.frameW, state.frameH);
  videoFrame.pause();
  document.getElementById("viewportLoading").style.display = "flex";
  videoFrame.src = `/clip_video?path=${encodeURIComponent(state.clipReferencia)}`;
  videoFrame.load();
  if (snapshotMascara) {
    const img = new Image();
    img.onload = () => { ctxMask.drawImage(img, 0, 0); pushHistory(); actualizarPreview("mascara"); };
    img.src = snapshotMascara;
  } else {
    pushHistory();
  }
  fitCanvasToViewport();
}

// El <video> puede tardar en tener el primer cuadro listo para pintar (clips
// pesados, disco lento, etc.) -- mientras tanto se ve todo negro sin este
// spinner. "loadeddata" se dispara apenas hay un frame decodificado, sirve
// tanto para la carga inicial como para cada vez que cambia el src.
videoFrame.addEventListener("loadeddata", () => {
  document.getElementById("viewportLoading").style.display = "none";
});
videoFrame.addEventListener("error", () => {
  document.getElementById("viewportLoading").style.display = "none";
});

// El scrubber real: seek nativo del <video> (instantaneo, nada de ida y vuelta
// a Python por cada movimiento -- eso era lo que hacia lento al scrubber viejo).
// Al reproducir, el canvas de mascara queda arriba en su propia capa, asi que
// se puede pintar con el video corriendo.
videoFrame.addEventListener("loadedmetadata", () => {
  const slider = document.getElementById("sliderTiempo");
  const dur = videoFrame.duration || 0;
  slider.max = dur || 100;
  if (dur) videoFrame.currentTime = Math.min(state.duracionSeg ? state.duracionSeg / 2 : dur / 2, dur - 0.05);
});
videoFrame.addEventListener("timeupdate", () => {
  document.getElementById("sliderTiempo").value = videoFrame.currentTime;
  document.getElementById("lblTiempo").textContent = `${formatoTiempo(videoFrame.currentTime)} / ${formatoTiempo(videoFrame.duration)}`;
});
document.getElementById("sliderTiempo").addEventListener("input", (e) => {
  videoFrame.currentTime = parseFloat(e.target.value);
});
document.getElementById("btnPlayPause").addEventListener("click", () => {
  if (videoFrame.paused) videoFrame.play(); else videoFrame.pause();
});
videoFrame.addEventListener("play", () => { document.getElementById("iconPlayPause").innerHTML = '<use href="#i-pause"/>'; });
videoFrame.addEventListener("pause", () => { document.getElementById("iconPlayPause").innerHTML = '<use href="#i-play"/>'; });

/* ---------------- Modo de reproduccion: repetir el clip o pasar al siguiente ---------------- */
const btnModoReproduccion = document.getElementById("btnModoReproduccion");
state.modoReproduccion = localStorage.getItem("clipxel_modo_reproduccion") || "repetir";

function pintarModoReproduccion() {
  if (state.modoReproduccion === "siguiente") {
    btnModoReproduccion.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>';
    btnModoReproduccion.title = "Al terminar: pasar al siguiente clip";
  } else {
    btnModoReproduccion.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>';
    btnModoReproduccion.title = "Al terminar: repetir este clip";
  }
}
pintarModoReproduccion();

btnModoReproduccion.addEventListener("click", () => {
  state.modoReproduccion = state.modoReproduccion === "repetir" ? "siguiente" : "repetir";
  localStorage.setItem("clipxel_modo_reproduccion", state.modoReproduccion);
  pintarModoReproduccion();
});

videoFrame.addEventListener("ended", () => {
  if (state.modoReproduccion === "siguiente") {
    const indiceActual = state.clips.indexOf(state.clipReferencia);
    const siguiente = state.clips[(indiceActual + 1) % state.clips.length];
    if (siguiente && siguiente !== state.clipReferencia) {
      cambiarClipReferencia(siguiente).then(() => videoFrame.play());
      return;
    }
  }
  videoFrame.currentTime = 0;
  videoFrame.play();
});
// El seek en si es instantaneo (nativo del navegador). Cuando el usuario se
// asienta en una posicion (evento "seeked", no en cada frame del arrastre),
// se le avisa a Python en segundo plano para que el cuadro de referencia de
// los paneles "antes/despues en vivo" tambien quede sincronizado -- sin
// bloquear ni frenar el scrubbing visual.
videoFrame.addEventListener("seeked", () => {
  if (!api.obtener_frame_en || !state.clipReferencia) return;
  api.obtener_frame_en(state.clipReferencia, videoFrame.currentTime)
    .then(() => actualizarPreview("mascara"))
    .catch(() => {});
});

function fitCanvasToViewport() {
  if (!state.frameImg) return;
  const vw = viewport.clientWidth - 24, vh = viewport.clientHeight - 24;
  state.fitScale.mascara = Math.min(vw / state.frameW, vh / state.frameH);
  state.zoom.mascara = 1;
  state.pan.mascara = {x: 0, y: 0};
  aplicarTransformEscenario();
}

// Ojo: a proposito NO se usa transform:scale() aca. Un solo sistema de
// posicionamiento (ancho/alto/left/top puestos directo por JS, sin transform
// de por medio) hace que la conversion de coordenadas del mouse sea directa
// y confiable -- es el mismo esquema que ya funciona bien en las vistas previas.
function aplicarTransformEscenario() {
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  const escala = state.fitScale.mascara * state.zoom.mascara;
  const dispW = state.frameW * escala, dispH = state.frameH * escala;
  const left = (vw - dispW) / 2 + state.pan.mascara.x;
  const top = (vh - dispH) / 2 + state.pan.mascara.y;
  [videoFrame, cnvMask].forEach(c => {
    c.style.width = dispW + "px";
    c.style.height = dispH + "px";
    c.style.left = left + "px";
    c.style.top = top + "px";
  });
  document.getElementById("zoomPct").textContent = Math.round(state.zoom.mascara * 100) + "%";
}

// Zoom centrado en el cursor (estilo Photoshop): el punto de la imagen que
// esta bajo el mouse se mantiene fijo en pantalla antes y despues del zoom,
// en vez de siempre zoomear desde el centro del visor.
function cambiarZoom(delta, clientX, clientY) {
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  const rect = viewport.getBoundingClientRect();
  const cursorX = (clientX != null) ? clientX - rect.left : vw / 2;
  const cursorY = (clientY != null) ? clientY - rect.top : vh / 2;

  const escalaVieja = state.fitScale.mascara * state.zoom.mascara;
  const dispWVieja = state.frameW * escalaVieja, dispHVieja = state.frameH * escalaVieja;
  const leftViejo = (vw - dispWVieja) / 2 + state.pan.mascara.x;
  const topViejo = (vh - dispHVieja) / 2 + state.pan.mascara.y;
  const imgX = (cursorX - leftViejo) / escalaVieja;
  const imgY = (cursorY - topViejo) / escalaVieja;

  state.zoom.mascara = Math.max(0.3, Math.min(6, state.zoom.mascara + delta));

  const escalaNueva = state.fitScale.mascara * state.zoom.mascara;
  const dispWNueva = state.frameW * escalaNueva, dispHNueva = state.frameH * escalaNueva;
  state.pan.mascara.x = cursorX - (vw - dispWNueva) / 2 - imgX * escalaNueva;
  state.pan.mascara.y = cursorY - (vh - dispHNueva) / 2 - imgY * escalaNueva;

  aplicarTransformEscenario();
}
document.getElementById("btnZoomIn").addEventListener("click", () => cambiarZoom(0.2));
document.getElementById("btnZoomOut").addEventListener("click", () => cambiarZoom(-0.2));
document.getElementById("hudZoomIn").addEventListener("click", () => cambiarZoom(0.2));
document.getElementById("hudZoomOut").addEventListener("click", () => cambiarZoom(-0.2));
document.getElementById("hudZoomFit").addEventListener("click", () => fitCanvasToViewport());

viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  cambiarZoom(e.deltaY < 0 ? 0.15 : -0.15, e.clientX, e.clientY);
}, {passive: false});

/* --- herramientas --- */
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll("#toolbarMascara .tool-btn[data-tool]").forEach(b => {
    b.classList.toggle("active", b.dataset.tool === tool);
  });
  viewport.classList.toggle("pan-mode", tool === "hand");
  document.getElementById("barOpcionesPincel").style.visibility = (tool === "brush" || tool === "eraser") ? "visible" : "hidden";
  actualizarCursorPincel();
}
document.querySelectorAll("#toolbarMascara .tool-btn[data-tool]").forEach(b => {
  b.addEventListener("click", () => setTool(b.dataset.tool));
});

/* ---------------- Tooltips de herramientas: capa flotante unica ----------------
   El <video> del editor a veces se compone en una capa de hardware de
   WebView2 que ignora el z-index del resto del DOM -- ningun z-index de un
   ancestro del tooltip alcanza contra eso. Por eso el tooltip real de cada
   boton (span.tip) nunca se muestra en su lugar: al pasar el mouse se copia
   su contenido a #tooltipFlotante, un unico elemento position:fixed pegado
   al final del <body>, y se lo posiciona a mano. */
const tooltipFlotante = document.getElementById("tooltipFlotante");
document.querySelectorAll("#toolbarMascara .tool-btn").forEach((btn) => {
  const fuente = btn.querySelector(".tip");
  if (!fuente) return;
  btn.addEventListener("mouseenter", () => {
    tooltipFlotante.innerHTML = fuente.innerHTML;
    const accionAtajo = btn.dataset.atajo;
    if (accionAtajo && typeof atajos !== "undefined" && atajos[accionAtajo]) {
      const linea = document.createElement("span");
      linea.className = "tip-atajo";
      linea.textContent = "Atajo: " + nombreCombo(atajos[accionAtajo]);
      tooltipFlotante.appendChild(linea);
    }
    const r = btn.getBoundingClientRect();
    const anchoTip = 190;
    let top = r.top + r.height / 2 - 60;
    top = Math.max(8, Math.min(top, window.innerHeight - 200));
    tooltipFlotante.style.left = (r.right + 10) + "px";
    tooltipFlotante.style.top = top + "px";
    tooltipFlotante.style.maxWidth = anchoTip + "px";
    tooltipFlotante.classList.add("visible");
  });
  btn.addEventListener("mouseleave", () => tooltipFlotante.classList.remove("visible"));
});

function actualizarCursorPincel() {
  const visible = (state.tool === "brush" || state.tool === "eraser") && !state.ctrlPanTemporal;
  brushCursor.style.display = visible ? "block" : "none";
  const borrando = state.tool === "eraser" || (state.tool === "brush" && state.altErasing);
  brushCursor.style.borderColor = borrando ? "#ff6666" : "#ffffff";
}

// Ctrl+click izquierdo mueve la vista como la herramienta Mano, sin
// cambiar la herramienta activa (asi no hay que ir y volver del pincel).
window.addEventListener("keydown", (e) => {
  if ((e.key === "Control" || e.key === "Meta") && !state.ctrlPanTemporal) {
    state.ctrlPanTemporal = true;
    viewport.classList.add("pan-mode");
    actualizarCursorPincel();
  }
});
window.addEventListener("keyup", (e) => {
  if ((e.key === "Control" || e.key === "Meta") && state.ctrlPanTemporal) {
    state.ctrlPanTemporal = false;
    if (state.tool !== "hand") viewport.classList.remove("pan-mode");
    actualizarCursorPincel();
  }
});
window.addEventListener("blur", () => {
  if (state.ctrlPanTemporal) {
    state.ctrlPanTemporal = false;
    if (state.tool !== "hand") viewport.classList.remove("pan-mode");
    actualizarCursorPincel();
  }
});

function coordsAImagen(clientX, clientY) {
  const rect = cnvMask.getBoundingClientRect();
  const escalaX = rect.width / state.frameW;
  const escalaY = rect.height / state.frameH;
  return {x: (clientX - rect.left) / escalaX, y: (clientY - rect.top) / escalaY};
}

viewport.addEventListener("mousemove", (e) => {
  if (state.isResizingBrush) {
    const dx = e.clientX - state.resizeStart.x, dy = e.clientY - state.resizeStart.y;
    setBrushSize(state.resizeStart.size + dx * 0.4);
    setHardness(state.resizeStart.hardness - dy * 0.5);
    // el diametro se muestra en pixeles de pantalla, pero brushSize esta en
    // coordenadas de imagen -- hay que escalarlo igual que el cursor normal
    // (mas abajo), si no el circulo que se ve mientras arrastras no coincide
    // con el que aparece despues de soltar el mouse.
    const rectCursor = cnvMask.getBoundingClientRect();
    const escala = state.frameW ? (rectCursor.width / state.frameW) : 1;
    const diametro = state.brushSize * 2 * escala;
    brushCursor.style.width = diametro + "px";
    brushCursor.style.height = diametro + "px";
    brushCursor.style.left = (state.resizeStart.x - diametro / 2) + "px";
    brushCursor.style.top = (state.resizeStart.y - diametro / 2) + "px";
    return;
  }

  const rectCursor = cnvMask.getBoundingClientRect();
  const escala = state.frameW ? (rectCursor.width / state.frameW) : 1;
  const diametro = state.brushSize * 2 * escala;
  brushCursor.style.width = diametro + "px";
  brushCursor.style.height = diametro + "px";
  brushCursor.style.left = (e.clientX - diametro / 2) + "px";
  brushCursor.style.top = (e.clientY - diametro / 2) + "px";

  if (state.isPanning) {
    state.pan.mascara.x = state.panStart.px + (e.clientX - state.panStart.x);
    state.pan.mascara.y = state.panStart.py + (e.clientY - state.panStart.y);
    aplicarTransformEscenario();
    return;
  }
  if (state.isPainting) pintarEn(e.clientX, e.clientY);
});
viewport.addEventListener("mouseenter", () => actualizarCursorPincel());
viewport.addEventListener("mouseleave", () => { brushCursor.style.display = "none"; });

viewport.addEventListener("contextmenu", (e) => { if (e.altKey || state.isResizingBrush) e.preventDefault(); });

viewport.addEventListener("mousedown", (e) => {
  // Los botones de zoom/reencuadre viven adentro del viewport -- sin esto,
  // el click les llega bien (hacen zoom) pero el mousedown tambien le
  // llega al viewport por debajo y arranca un trazo del pincel al mismo
  // tiempo.
  if (e.target.closest(".zoom-hud")) return;
  if (e.altKey && e.button === 2) {
    e.preventDefault();
    state.isResizingBrush = true;
    state.resizeStart = {x: e.clientX, y: e.clientY, size: state.brushSize, hardness: state.hardness};
    const rectCursor0 = cnvMask.getBoundingClientRect();
    const escala0 = state.frameW ? (rectCursor0.width / state.frameW) : 1;
    const diametro0 = state.brushSize * 2 * escala0;
    brushCursor.style.display = "block";
    brushCursor.style.left = (e.clientX - diametro0 / 2) + "px";
    brushCursor.style.top = (e.clientY - diametro0 / 2) + "px";
    brushCursor.style.width = brushCursor.style.height = diametro0 + "px";
    return;
  }
  if (state.tool === "hand" || ((e.ctrlKey || e.metaKey) && e.button === 0)) {
    state.isPanning = true;
    state.panStart = {x: e.clientX, y: e.clientY, px: state.pan.mascara.x, py: state.pan.mascara.y};
    viewport.classList.add("panning");
  } else if (state.frameImg) {
    state.isPainting = true;
    state.lastPt = coordsAImagen(e.clientX, e.clientY);
    pintarEn(e.clientX, e.clientY);
  }
});
window.addEventListener("mouseup", () => {
  if (state.isPainting) {
    state.isPainting = false; state.lastPt = null; pushHistory(); actualizarPreview("mascara");
  }
  if (state.isPanning) { state.isPanning = false; viewport.classList.remove("panning"); }
  if (state.isResizingBrush) { state.isResizingBrush = false; actualizarCursorPincel(); }
});

function estamparDab(x, y) {
  const radio = state.brushSize;
  const dureza = state.hardness / 100;
  const opacidad = state.opacity / 100;
  const borrando = state.tool === "eraser" || (state.tool === "brush" && state.altErasing);
  ctxMask.globalCompositeOperation = borrando ? "destination-out" : "source-over";
  // el radio interior tiene que ser siempre menor al exterior: si son iguales (dureza 100%)
  // el gradiente queda degenerado y algunos motores de renderizado no pintan nada.
  const radioInterior = Math.max(0, Math.min(radio * dureza, radio - 0.5));
  const grad = ctxMask.createRadialGradient(x, y, radioInterior, x, y, radio);
  grad.addColorStop(0, `rgba(58,160,255,${opacidad})`);
  grad.addColorStop(1, "rgba(58,160,255,0)");
  ctxMask.fillStyle = grad;
  ctxMask.beginPath();
  ctxMask.arc(x, y, radio, 0, Math.PI * 2);
  ctxMask.fill();
}

function pintarEn(clientX, clientY) {
  const pt = coordsAImagen(clientX, clientY);
  if (state.lastPt) {
    const dx = pt.x - state.lastPt.x, dy = pt.y - state.lastPt.y;
    const dist = Math.hypot(dx, dy);
    const paso = Math.max(1, state.brushSize * 0.22);
    const pasos = Math.max(1, Math.floor(dist / paso));
    for (let i = 1; i <= pasos; i++) {
      estamparDab(state.lastPt.x + (dx * i) / pasos, state.lastPt.y + (dy * i) / pasos);
    }
  } else {
    estamparDab(pt.x, pt.y);
  }
  state.lastPt = pt;
  cnvMask.style.opacity = "0.7";
  debounceActualizarPreview("mascara");
}

function hayMascara() {
  if (!state.frameImg) return false;
  const data = ctxMask.getImageData(0, 0, cnvMask.width, cnvMask.height).data;
  for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 10) return true;
  return false;
}

/* --- historial --- */
function pushHistory() {
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(cnvMask.toDataURL());
  state.historyIndex = state.history.length - 1;
  if (state.history.length > 25) { state.history.shift(); state.historyIndex--; }
  state.maskBaseSnapshot = state.history[state.historyIndex];
}
function restaurarDesde(dataUrl) {
  const img = new Image();
  img.onload = () => { ctxMask.clearRect(0, 0, cnvMask.width, cnvMask.height); ctxMask.drawImage(img, 0, 0); actualizarPreview("mascara"); };
  img.src = dataUrl;
}
// Igual que restaurarDesde, pero estira la imagen al tamaño actual del
// lienzo: una plantilla guardada con un clip (por ej. a 1080p) puede
// aplicarse despues sobre un clip de otra resolucion (por ej. 4K) y tiene
// que cubrir todo el frame, no quedar pegada en la esquina a su tamaño
// original.
function cargarMascaraEscalada(dataUrl) {
  const img = new Image();
  img.onload = () => {
    ctxMask.clearRect(0, 0, cnvMask.width, cnvMask.height);
    ctxMask.drawImage(img, 0, 0, cnvMask.width, cnvMask.height);
    fijarMascaraBase(cnvMask.toDataURL());
    pushHistory();
    actualizarPreview("mascara");
  };
  img.src = dataUrl;
}
function deshacer() {
  if (state.historyIndex > 0) { state.historyIndex--; restaurarDesde(state.history[state.historyIndex]); state.maskBaseSnapshot = state.history[state.historyIndex]; }
}
function rehacer() {
  if (state.historyIndex < state.history.length - 1) { state.historyIndex++; restaurarDesde(state.history[state.historyIndex]); state.maskBaseSnapshot = state.history[state.historyIndex]; }
}
function rotarMascara(sentido) {
  // sentido: 1 = derecha (horario), -1 = izquierda (antihorario)
  const tmp = document.createElement("canvas");
  tmp.width = cnvMask.width; tmp.height = cnvMask.height;
  const tctx = tmp.getContext("2d");
  tctx.translate(tmp.width / 2, tmp.height / 2);
  tctx.rotate(sentido * Math.PI / 2);
  tctx.drawImage(cnvMask, -tmp.width / 2, -tmp.height / 2);
  ctxMask.clearRect(0, 0, cnvMask.width, cnvMask.height);
  ctxMask.drawImage(tmp, 0, 0);
  pushHistory();
  actualizarPreview("mascara");
}
document.getElementById("btnRotateLeft").addEventListener("click", () => rotarMascara(-1));
document.getElementById("btnRotateRight").addEventListener("click", () => rotarMascara(1));

/* --- campos "scrub" estilo Photoshop: arrastras el numero, doble click para escribir --- */
function crearCampoScrub(id, {min, max, valorInicial, sensibilidad = 1, onChange}) {
  const el = document.getElementById(id);
  const spanValor = el.querySelector(".sf-value");
  let valor = valorInicial;

  function fijar(v, notificar = true) {
    valor = Math.max(min, Math.min(max, Math.round(v)));
    spanValor.textContent = valor;
    if (notificar && onChange) onChange(valor);
  }

  let arrastrando = false, startX = 0, startVal = 0, huboArrastre = false;
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    arrastrando = true; huboArrastre = false; startX = e.clientX; startVal = valor;
    el.classList.add("scrubbing");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!arrastrando) return;
    if (Math.abs(e.clientX - startX) > 2) huboArrastre = true;
    fijar(startVal + (e.clientX - startX) * sensibilidad);
  });
  window.addEventListener("mouseup", () => {
    if (arrastrando) { arrastrando = false; el.classList.remove("scrubbing"); }
  });
  el.addEventListener("dblclick", () => {
    const input = document.createElement("input");
    input.type = "text"; input.className = "sf-edit"; input.value = valor;
    spanValor.replaceWith(input);
    input.focus(); input.select();
    const confirmar = () => {
      const n = parseFloat(input.value);
      input.replaceWith(spanValor);
      if (!isNaN(n)) fijar(n);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") confirmar(); if (e.key === "Escape") { input.replaceWith(spanValor); } });
    input.addEventListener("blur", confirmar);
  });

  fijar(valorInicial, false);
  return {set: (v) => fijar(v, false)};
}

const campoTamano = crearCampoScrub("scrubSize", {min: 1, max: 300, valorInicial: 28, sensibilidad: 0.6,
  onChange: (v) => { state.brushSize = v; guardarConfigDebounced(); }});
const campoDureza = crearCampoScrub("scrubHardness", {min: 0, max: 100, valorInicial: 100, sensibilidad: 0.7,
  onChange: (v) => { state.hardness = v; guardarConfigDebounced(); }});
const campoOpacidad = crearCampoScrub("scrubOpacity", {min: 1, max: 100, valorInicial: 100, sensibilidad: 0.7,
  onChange: (v) => { state.opacity = v; guardarConfigDebounced(); }});
const campoAngulo = crearCampoScrub("scrubAngle", {min: -180, max: 180, valorInicial: 0, sensibilidad: 0.5,
  onChange: (v) => {
    state.angleFine = v;
    if (!state.maskBaseSnapshot) return;
    const img = new Image();
    img.onload = () => {
      ctxMask.clearRect(0, 0, cnvMask.width, cnvMask.height);
      ctxMask.save();
      ctxMask.translate(cnvMask.width / 2, cnvMask.height / 2);
      ctxMask.rotate(state.angleFine * Math.PI / 180);
      ctxMask.drawImage(img, -cnvMask.width / 2, -cnvMask.height / 2);
      ctxMask.restore();
      debounceActualizarPreview("mascara");
    };
    img.src = state.maskBaseSnapshot;
  }});

function setBrushSize(v) { state.brushSize = Math.max(1, Math.min(300, v)); campoTamano.set(state.brushSize); guardarConfigDebounced(); }
function setHardness(v) { state.hardness = Math.max(0, Math.min(100, v)); campoDureza.set(state.hardness); guardarConfigDebounced(); }
function setOpacity(v) { state.opacity = Math.max(1, Math.min(100, v)); campoOpacidad.set(state.opacity); guardarConfigDebounced(); }

document.getElementById("btnLoadPng").addEventListener("click", async () => {
  if (!api.elegir_mascara_png) return;
  const resultado = await api.elegir_mascara_png(state.frameW, state.frameH);
  if (!resultado) return;
  const img = new Image();
  img.onload = () => {
    ctxMask.clearRect(0, 0, cnvMask.width, cnvMask.height);
    ctxMask.drawImage(img, 0, 0, cnvMask.width, cnvMask.height);
    cnvMask.style.opacity = "0.55";
    fijarMascaraBase(cnvMask.toDataURL());
    pushHistory();
    actualizarPreview("mascara");
  };
  img.src = resultado;
});

function nombreSugeridoMascara() {
  const meta = _metaCache[state.clipReferencia] && _metaCache[state.clipReferencia].metadata;
  const camara = meta && [meta.marca, meta.modelo].filter(Boolean).join(" ");
  return camara ? `${camara} - ClipxelMask` : "ClipxelMask";
}

document.getElementById("btnBajarPng").addEventListener("click", async () => {
  if (!hayMascara()) { alert("Primero marca una mascara."); return; }
  if (!api.guardar_mascara_png) return;
  await api.guardar_mascara_png(cnvMask.toDataURL(), nombreSugeridoMascara());
});

/* ---------------- Resaltar (brillo/contraste/saturacion) ---------------- */
// El panel se reubica como hijo directo de <body> con position:fixed la
// primera vez que se abre. Asi evita quedar atrapado en el "contexto de
// apilado" que crea el panel del paso (que anima opacity/transform al
// entrar) y cualquier otro elemento (como el video) que compita por encima
// -- position:fixed + hijo de body es lo mas arriba que se puede estar.
const realcePop = document.getElementById("realcePop");
const btnRealce = document.getElementById("btnRealce");
document.body.appendChild(realcePop);
realcePop.style.position = "fixed";
realcePop.style.zIndex = "99999";

function posicionarRealcePop() {
  const r = btnRealce.getBoundingClientRect();
  realcePop.style.left = (r.right + 10) + "px";
  realcePop.style.top = r.top + "px";
}

btnRealce.addEventListener("click", (e) => {
  e.stopPropagation();
  posicionarRealcePop();
  realcePop.classList.toggle("open");
});
document.addEventListener("click", (e) => {
  if (realcePop.classList.contains("open") && !realcePop.contains(e.target) && e.target !== btnRealce) {
    realcePop.classList.remove("open");
  }
});

function aplicarRealce() {
  const b = document.getElementById("sliderBrillo").value;
  const c = document.getElementById("sliderContraste").value;
  const s = document.getElementById("sliderSaturacion").value;
  videoFrame.style.filter = `brightness(${b}%) contrast(${c}%) saturate(${s}%)`;
}
document.getElementById("sliderBrillo").addEventListener("input", aplicarRealce);
document.getElementById("sliderContraste").addEventListener("input", aplicarRealce);
document.getElementById("sliderSaturacion").addEventListener("input", aplicarRealce);
document.getElementById("btnResetRealce").addEventListener("click", () => {
  document.getElementById("sliderBrillo").value = 100;
  document.getElementById("sliderContraste").value = 100;
  document.getElementById("sliderSaturacion").value = 100;
  videoFrame.style.filter = "none";
});

/* ---------------- Ajustar mascara cargada: calado, extender/reducir, opacidad ---------------- */
const ajusteMascaraPop = document.getElementById("ajusteMascaraPop");
const btnAjustarMascara = document.getElementById("btnAjustarMascara");
document.body.appendChild(ajusteMascaraPop);
ajusteMascaraPop.style.position = "fixed";
ajusteMascaraPop.style.zIndex = "99999";

function posicionarAjusteMascaraPop() {
  const r = btnAjustarMascara.getBoundingClientRect();
  ajusteMascaraPop.style.left = (r.right + 10) + "px";
  ajusteMascaraPop.style.top = r.top + "px";
}
btnAjustarMascara.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!state.mascaraBase) state.mascaraBase = cnvMask.toDataURL();
  posicionarAjusteMascaraPop();
  ajusteMascaraPop.classList.toggle("open");
});
document.addEventListener("click", (e) => {
  if (ajusteMascaraPop.classList.contains("open") && !ajusteMascaraPop.contains(e.target) && e.target !== btnAjustarMascara) {
    ajusteMascaraPop.classList.remove("open");
  }
});

// Guarda la mascara "original" (recien cargada, sin ajustes) para poder
// recalcular calado/extender/opacidad desde cero cada vez que se mueve un
// slider, en vez de ir degradando la imagen aplicando ajustes sobre ajustes.
function fijarMascaraBase(dataUrl) {
  state.mascaraBase = dataUrl;
  document.getElementById("sliderCalado").value = 0;
  document.getElementById("sliderExtender").value = 0;
  document.getElementById("sliderOpacidadMascara").value = 100;
}

function _crecerMascara(canvasFuente, pasos) {
  // Dilata pintando 8 copias desplazadas 1px con blend "lighter" (suma y
  // satura en 255), repitiendo "pasos" veces -- una aproximacion barata a
  // una dilatacion morfologica real, suficiente para uso visual.
  let actual = canvasFuente;
  const offs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  for (let i = 0; i < pasos; i++) {
    const salida = document.createElement("canvas");
    salida.width = canvasFuente.width; salida.height = canvasFuente.height;
    const sctx = salida.getContext("2d");
    sctx.drawImage(actual, 0, 0);
    sctx.globalCompositeOperation = "lighter";
    offs.forEach(([dx, dy]) => sctx.drawImage(actual, dx, dy));
    actual = salida;
  }
  return actual;
}

function _invertirAlpha(canvasFuente) {
  const salida = document.createElement("canvas");
  salida.width = canvasFuente.width; salida.height = canvasFuente.height;
  const sctx = salida.getContext("2d");
  sctx.drawImage(canvasFuente, 0, 0);
  const datos = sctx.getImageData(0, 0, salida.width, salida.height);
  for (let i = 3; i < datos.data.length; i += 4) datos.data[i] = 255 - datos.data[i];
  sctx.putImageData(datos, 0, 0);
  return salida;
}

function aplicarAjustesMascara() {
  if (!state.mascaraBase) return;
  const img = new Image();
  img.onload = () => {
    let base = document.createElement("canvas");
    base.width = cnvMask.width; base.height = cnvMask.height;
    base.getContext("2d").drawImage(img, 0, 0);

    const extender = Math.round(Number(document.getElementById("sliderExtender").value));
    if (extender !== 0) {
      const pasos = Math.abs(extender);
      base = extender > 0
        ? _crecerMascara(base, pasos)
        : _invertirAlpha(_crecerMascara(_invertirAlpha(base), pasos));
    }

    const calado = Number(document.getElementById("sliderCalado").value);
    if (calado > 0) {
      const desenfocado = document.createElement("canvas");
      desenfocado.width = base.width; desenfocado.height = base.height;
      const dctx = desenfocado.getContext("2d");
      dctx.filter = `blur(${calado}px)`;
      dctx.drawImage(base, 0, 0);
      base = desenfocado;
    }

    ctxMask.clearRect(0, 0, cnvMask.width, cnvMask.height);
    ctxMask.globalAlpha = Number(document.getElementById("sliderOpacidadMascara").value) / 100;
    ctxMask.drawImage(base, 0, 0);
    ctxMask.globalAlpha = 1;
    actualizarPreview("mascara");
  };
  img.src = state.mascaraBase;
}
document.getElementById("sliderCalado").addEventListener("input", aplicarAjustesMascara);
document.getElementById("sliderExtender").addEventListener("input", aplicarAjustesMascara);
document.getElementById("sliderOpacidadMascara").addEventListener("input", aplicarAjustesMascara);
document.getElementById("sliderCalado").addEventListener("change", pushHistory);
document.getElementById("sliderExtender").addEventListener("change", pushHistory);
document.getElementById("sliderOpacidadMascara").addEventListener("change", pushHistory);
document.getElementById("btnResetAjusteMascara").addEventListener("click", () => {
  document.getElementById("sliderCalado").value = 0;
  document.getElementById("sliderExtender").value = 0;
  document.getElementById("sliderOpacidadMascara").value = 100;
  aplicarAjustesMascara();
  pushHistory();
});

window.addEventListener("resize", () => { if (state.step === 1) fitCanvasToViewport(); });

/* ---------------- Paneles redimensionables ---------------- */
function habilitarResizer(resizerEl, panelEl, {min = 220, max = 1400} = {}) {
  let arrastrando = false, startX = 0, startWidth = 0;
  resizerEl.addEventListener("mousedown", (e) => {
    arrastrando = true; startX = e.clientX; startWidth = panelEl.getBoundingClientRect().width;
    resizerEl.classList.add("dragging");
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!arrastrando) return;
    const nuevo = Math.max(min, Math.min(max, startWidth - (e.clientX - startX)));
    panelEl.style.flex = `0 0 ${nuevo}px`;
    panelEl.style.width = nuevo + "px";
    if (state.step === 1) fitCanvasToViewport();
  });
  window.addEventListener("mouseup", () => {
    if (arrastrando) { arrastrando = false; resizerEl.classList.remove("dragging"); document.body.style.userSelect = ""; }
  });
}
habilitarResizer(document.getElementById("resizerMotor"), document.getElementById("previewColMotor"));
habilitarResizer(document.getElementById("resizerProcesar"), document.querySelector(".log-col"));

/* ---------------- Paneles de vista previa (Antes/Despues) reutilizables ---------------- */
const panEstadoPorPanel = {};

const zoomEstadoPorPanel = {};

function crearPanelPreview(titulo, id) {
  const wrap = document.createElement("div");
  wrap.className = "preview-panel";
  wrap.innerHTML = `
    <div class="preview-head">
      <span>${titulo}</span>
      <div class="mini-tools">
        <button class="mini-btn" data-act="out" title="Alejar"><svg width="13" height="13"><use href="#i-zoomout"/></svg></button>
        <button class="mini-btn" data-act="in" title="Acercar"><svg width="13" height="13"><use href="#i-zoomin"/></svg></button>
        <button class="mini-btn" data-act="reset" title="Ajustar"><svg width="13" height="13"><use href="#i-move"/></svg></button>
        <button class="mini-btn" data-act="expand" title="Expandir"><svg width="13" height="13"><use href="#i-expand"/></svg></button>
      </div>
    </div>
    <div class="preview-canvas-wrap" id="${id}-wrap"><canvas id="${id}"></canvas></div>`;
  zoomEstadoPorPanel[id] = 1;
  panEstadoPorPanel[id] = {x: 0, y: 0};
  wrap.querySelector('[data-act="in"]').addEventListener("click", () => { zoomEstadoPorPanel[id] = Math.min(4, zoomEstadoPorPanel[id] + 0.25); aplicarZoomPreview(id); });
  wrap.querySelector('[data-act="out"]').addEventListener("click", () => { zoomEstadoPorPanel[id] = Math.max(0.4, zoomEstadoPorPanel[id] - 0.25); aplicarZoomPreview(id); });
  wrap.querySelector('[data-act="reset"]').addEventListener("click", () => { zoomEstadoPorPanel[id] = 1; panEstadoPorPanel[id] = {x: 0, y: 0}; aplicarZoomPreview(id); });
  wrap.querySelector('[data-act="expand"]').addEventListener("click", () => expandirPreview(id, titulo));

  const contenedor = wrap.querySelector(".preview-canvas-wrap");
  contenedor.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomEstadoPorPanel[id] = Math.max(0.4, Math.min(4, zoomEstadoPorPanel[id] + (e.deltaY < 0 ? 0.15 : -0.15)));
    aplicarZoomPreview(id);
  }, {passive: false});

  let arrastrando = false, startX = 0, startY = 0, panStart = {x: 0, y: 0};
  contenedor.addEventListener("mousedown", (e) => {
    arrastrando = true; startX = e.clientX; startY = e.clientY;
    panStart = {...panEstadoPorPanel[id]};
    contenedor.classList.add("panning");
  });
  window.addEventListener("mousemove", (e) => {
    if (!arrastrando) return;
    panEstadoPorPanel[id] = {x: panStart.x + (e.clientX - startX), y: panStart.y + (e.clientY - startY)};
    aplicarZoomPreview(id);
  });
  window.addEventListener("mouseup", () => { arrastrando = false; contenedor.classList.remove("panning"); });

  // como en el visor de Premiere: mientras este en modo "Ajustar" (zoom == 1, el
  // default), el encuadre se recalcula solo cada vez que el panel cambia de tamano
  // (al arrastrar el separador, al redimensionar la ventana, etc.), no solo cuando
  // llega una imagen nueva.
  new ResizeObserver(() => {
    const cnv = document.getElementById(id);
    if (zoomEstadoPorPanel[id] === 1 && cnv && cnv.dataset.pintado) recalcularEncuadre(id);
  }).observe(contenedor);

  return wrap;
}
function recalcularEncuadre(canvasId) {
  const c = document.getElementById(canvasId);
  if (!c || !c.width || !c.height || !c.dataset.pintado) return;
  const wrapEl = c.parentElement;
  const maxW = Math.max(40, wrapEl.clientWidth - 16), maxH = Math.max(40, wrapEl.clientHeight - 16);
  const escala = Math.max(0.05, Math.min(maxW / c.width, maxH / c.height, 1) || 1);
  c.dataset.baseW = c.width * escala;
  c.dataset.ratio = c.height / c.width;
  aplicarZoomPreview(canvasId);
}
function aplicarZoomPreview(canvasId) {
  const c = document.getElementById(canvasId);
  const base = Number(c.dataset.baseW || 0);
  if (!base) return;
  const z = zoomEstadoPorPanel[canvasId] || 1;
  const pan = panEstadoPorPanel[canvasId] || {x: 0, y: 0};
  const ratio = Number(c.dataset.ratio || 1);
  c.style.width = (base * z) + "px";
  c.style.height = (base * z * ratio) + "px";
  c.style.transform = `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`;
}
function pintarImagenEnCanvas(canvasId, dataUrl) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const img = new Image();
  img.onload = () => {
    requestAnimationFrame(() => {
      c.width = img.width; c.height = img.height;
      c.dataset.pintado = "1";
      c.getContext("2d").drawImage(img, 0, 0);
      recalcularEncuadre(canvasId);
      void c.offsetHeight; // fuerza un reflow: en esta combinacion pywebview/WebView2
                            // a veces el canvas no se repinta solo tras dibujar por codigo.
    });
  };
  img.src = dataUrl;
}
function expandirPreview(canvasId, titulo) {
  const src = document.getElementById(canvasId).toDataURL();
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:100;animation:fadein .2s ease";
  overlay.innerHTML = `<div style="background:var(--bg-card);border-radius:20px;padding:20px;width:92vw;height:90vh;display:flex;flex-direction:column;gap:12px;align-items:center;box-sizing:border-box">
    <div style="font-weight:700;flex-shrink:0">${titulo} — click afuera de la imagen para cerrar</div>
    <div style="flex:1;min-height:0;width:100%;display:flex;align-items:center;justify-content:center;background:var(--bg-canvas);border-radius:12px">
      <img src="${src}" style="max-width:100%;max-height:100%;object-fit:contain">
    </div>
  </div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

const panelAntesMotor = crearPanelPreview("Antes (en vivo)", "cnvAntesMotor");
const panelDespuesMotor = crearPanelPreview("Despues (en vivo)", "cnvDespuesMotor");
document.getElementById("previewColMotor").append(panelAntesMotor, panelDespuesMotor);

function debounceActualizarPreview(contexto) {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => actualizarPreview(contexto), 160);
}
async function actualizarPreview(contexto) {
  if (contexto === "mascara") return; // el paso Mascara ya no tiene paneles antes/despues al costado (sacados a pedido)
  if (!state.frameImg || !hayMascara()) return;
  const maskB64 = cnvMask.toDataURL();
  const resultado = await api.render_preview(state.motor, maskB64, state.sigma);
  if (!resultado) return;
  pintarImagenEnCanvas("cnvAntesMotor", resultado.antes_b64);
  pintarImagenEnCanvas("cnvDespuesMotor", resultado.despues_b64);
}

/* ---------------- Paso 3: Motor y calidad ---------------- */
function actualizarVisibilidadSigma() {
  document.getElementById("grupoSigma").style.display = state.motor === "blur" ? "block" : "none";
}
document.querySelectorAll(".engine-card").forEach(card => {
  card.addEventListener("click", () => {
    document.querySelectorAll(".engine-card").forEach(c => c.classList.remove("selected"));
    card.classList.add("selected");
    state.motor = card.dataset.engine;
    actualizarVisibilidadSigma();
    actualizarPreview("motor");
    guardarConfigDebounced();
  });
});
actualizarVisibilidadSigma();
document.getElementById("sliderSigma").addEventListener("input", (e) => { state.sigma = Number(e.target.value); debounceActualizarPreview("motor"); });
document.querySelectorAll('input[name="calidad"]').forEach(r => r.addEventListener("change", (e) => { state.calidad = e.target.value; guardarConfigDebounced(); }));
document.querySelectorAll("#pillVelocidad .pill").forEach(p => {
  p.addEventListener("click", () => {
    document.querySelectorAll("#pillVelocidad .pill").forEach(x => x.classList.remove("selected"));
    p.classList.add("selected");
    state.velocidad = p.dataset.vel;
  });
});
document.getElementById("selectResolucion").addEventListener("change", (e) => { state.resolucion = e.target.value; guardarConfigDebounced(); });

/* ---------------- Carpeta de exportacion ---------------- */
function pintarCarpetaSalida(carpeta) {
  const lbl = document.getElementById("lblCarpetaSalida");
  const btnRestablecer = document.getElementById("btnRestablecerCarpetaSalida");
  if (carpeta) {
    lbl.textContent = `Se va a crear "Clipxel" dentro de: ${carpeta}`;
    btnRestablecer.style.display = "inline-flex";
  } else {
    lbl.textContent = 'Predeterminada: junto al medio original, en una carpeta "Clipxel".';
    btnRestablecer.style.display = "none";
  }
}
(async () => {
  if (!api.obtener_carpeta_salida) return;
  const { carpeta } = await api.obtener_carpeta_salida();
  pintarCarpetaSalida(carpeta);
})();
document.getElementById("btnElegirCarpetaSalida").addEventListener("click", async () => {
  const { carpeta } = await api.elegir_carpeta_salida();
  pintarCarpetaSalida(carpeta);
});
document.getElementById("btnRestablecerCarpetaSalida").addEventListener("click", async () => {
  const { carpeta } = await api.restablecer_carpeta_salida();
  pintarCarpetaSalida(carpeta);
});

/* ---------------- Paso 4: Procesar ---------------- */
const CIRC = 2 * Math.PI * 72;
function setAnillo(frac) {
  const off = CIRC - frac * CIRC;
  document.getElementById("ringFill").style.strokeDashoffset = off;
  document.getElementById("ringLabel").textContent = Math.round(frac * 100) + "%";
}
function logLinea(texto, tipo) {
  const box = document.getElementById("logBox");
  const div = document.createElement("div");
  if (tipo) div.className = tipo;
  div.textContent = texto;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function actualizarProgresoClip(index, frac) {
  const rows = document.querySelectorAll("#clipList .clip-row .bar > div");
  if (rows[index]) rows[index].style.width = Math.round(frac * 100) + "%";
}

function renderizarListaArchivosProceso() {
  const cont = document.getElementById("archivosProcesoList");
  cont.innerHTML = "";
  state.clips.forEach((ruta) => {
    const nombre = ruta.split(/[\\/]/).pop();
    const row = document.createElement("div");
    row.className = "archivo-proceso-row";
    row.innerHTML = `<span class="name">${nombre}</span><div class="bar"><div style="width:0%"></div></div><button class="btn-carpeta">Mostrar en carpeta</button>`;
    cont.appendChild(row);
  });
}

function actualizarFilaArchivoProceso(index, frac, rutaSalida) {
  const row = document.querySelectorAll("#archivosProcesoList .archivo-proceso-row")[index];
  if (!row) return;
  if (frac >= 1) {
    row.classList.remove("exito", "error");
    row.classList.add(rutaSalida ? "exito" : "error");
    if (rutaSalida) {
      const btn = row.querySelector(".btn-carpeta");
      btn.onclick = () => api.mostrar_en_carpeta(rutaSalida).catch(() => {});
    }
  } else {
    row.querySelector(".bar > div").style.width = Math.round(frac * 100) + "%";
  }
}

let _pollTimer = null;
let _logsMostrados = 0;
let _seEstaCancelando = false;

document.getElementById("btnCancelar").addEventListener("click", () => {
  const btnCancelar = document.getElementById("btnCancelar");
  btnCancelar.disabled = true;
  btnCancelar.textContent = "Cancelando...";
  _seEstaCancelando = true;
  api.cancelar_procesamiento().catch(() => {});
});

async function procesarTodo() {
  const btn = document.getElementById("btnSiguiente");
  const btnCancelar = document.getElementById("btnCancelar");

  _seEstaCancelando = false;
  state.renderizando = true;
  document.getElementById("btnAtras").disabled = true;
  btn.disabled = true;
  document.getElementById("antesDeProcesar").style.display = "none";
  document.getElementById("estadoProcesando").style.display = "flex";
  btnCancelar.style.display = "inline-flex";
  btnCancelar.disabled = false;
  btnCancelar.textContent = "Cancelar";
  document.getElementById("logBox").innerHTML = "";
  _logsMostrados = 0;
  logLinea("Iniciando procesamiento...");
  setAnillo(0);
  document.querySelector(".ring-wrap").classList.add("procesando");
  document.querySelectorAll("#clipList .clip-row .bar > div").forEach((b) => { b.style.width = "0%"; });
  renderizarListaArchivosProceso();
  const imgPreviewRender = document.getElementById("previewRenderImg");
  imgPreviewRender.style.display = "none";
  document.getElementById("previewRenderPlaceholder").style.display = "block";

  const payload = {
    mascara_b64: cnvMask.toDataURL(),
    motor: state.motor, sigma: state.sigma, calidad: state.calidad,
    velocidad: state.velocidad, resolucion: state.resolucion, clips: state.clips,
  };

  // No esperamos la respuesta de esta llamada: en esta combinacion de tecnologias
  // (pywebview + WinForms + WebView2) la promesa a veces se queda colgada aunque
  // el trabajo en Python arranque bien igual. Arrancamos a consultar el progreso
  // en paralelo, que es una llamada mas chica y confiable.
  api.procesar_todo(payload).catch((err) => {
    logLinea("Aviso al iniciar (puede ser normal): " + err.message);
  });

  let intentosSinRespuesta = 0;
  let vimosArranque = false;
  let tick = 0;
  clearInterval(_pollTimer);
  _pollTimer = setInterval(async () => {
    let p;
    try {
      const resp = await fetch(`/progreso?_=${Date.now()}`);
      p = await resp.json();
      intentosSinRespuesta = 0;
    } catch (err) {
      intentosSinRespuesta++;
      if (intentosSinRespuesta === 6) {
        logLinea("No se pudo consultar el progreso todavia, sigo intentando...");
      }
      return;
    }
    if (p.total > 0 || (p.logs && p.logs.length > 0)) vimosArranque = true;
    const porClip = p.por_clip || [];
    const fracGeneral = p.total ? porClip.reduce((a, b) => a + b, 0) / p.total : 0;
    setAnillo(fracGeneral);
    document.getElementById("lblProcesoInfo").textContent = `${p.completados} / ${p.total} clips`;
    porClip.forEach((frac, i) => actualizarProgresoClip(i, frac));
    const rutasSalida = p.rutas_salida || [];
    porClip.forEach((frac, i) => actualizarFilaArchivoProceso(i, frac, rutasSalida[i]));
    (p.logs || []).slice(_logsMostrados).forEach((l) => logLinea(l.mensaje, l.ok ? "ok" : "err"));
    _logsMostrados = (p.logs || []).length;
    document.querySelector(".ring-wrap").classList.toggle("procesando", !p.terminado);

    // Vista previa en vivo (de prueba): baja frecuencia, solo orientativa.
    tick++;
    if (!p.terminado && tick % 4 === 0) {
      try {
        const respPrev = await fetch(`/preview_render?_=${Date.now()}`);
        const prev = await respPrev.json();
        if (prev.preview_b64) {
          imgPreviewRender.src = prev.preview_b64;
          imgPreviewRender.style.display = "block";
          document.getElementById("previewRenderPlaceholder").style.display = "none";
        }
      } catch (err) { /* la preview es cosmetica, se ignora si falla */ }
    }

    if (p.terminado && vimosArranque) {
      clearInterval(_pollTimer);
      state.renderizando = false;
      document.getElementById("btnAtras").disabled = state.step === 0;
      btn.disabled = false;
      btnCancelar.style.display = "none";
      document.querySelector(".ring-wrap").classList.remove("procesando");
      imgPreviewRender.style.display = "none";
      document.getElementById("previewRenderPlaceholder").textContent = "Listo.";
      document.getElementById("previewRenderPlaceholder").style.display = "block";
      if (_seEstaCancelando) {
        _seEstaCancelando = false;
        resetearPasoProcesar();
        mostrarPaso(2);
      }
    }
  }, 500);
}

function resetearPasoProcesar() {
  document.getElementById("antesDeProcesar").style.display = "flex";
  document.getElementById("estadoProcesando").style.display = "none";
  document.getElementById("logBox").innerHTML = "";
  _logsMostrados = 0;
  setAnillo(0);
  document.querySelectorAll("#clipList .clip-row .bar > div").forEach((b) => { b.style.width = "0%"; });
  document.getElementById("archivosProcesoList").innerHTML = "";
  imgPreviewRender.style.display = "none";
  document.getElementById("previewRenderPlaceholder").textContent = "Se va a ir viendo aca, en baja calidad, mientras se procesa.";
  document.getElementById("previewRenderPlaceholder").style.display = "block";
}

/* ---------------- Atajos de teclado (estilo Photoshop, 100% personalizables) ---------------- */
// Cada accion es un combo {key, ctrl}. Los defaults calcan los atajos de
// Photoshop: B/E/H para herramientas, [ ] para tamano, Ctrl+Z/Y deshacer/
// rehacer, Ctrl +/- /0 para zoom, Espacio para reproducir.
const ATAJOS_DEFAULT = {
  brush: { key: "b", ctrl: false },
  eraser: { key: "e", ctrl: false },
  hand: { key: "h", ctrl: false },
  brushSmaller: { key: "[", ctrl: false },
  brushBigger: { key: "]", ctrl: false },
  hardnessSmaller: { key: "[", ctrl: false, shift: true },
  hardnessBigger: { key: "]", ctrl: false, shift: true },
  rotateLeft: { key: ",", ctrl: false },
  rotateRight: { key: ".", ctrl: false },
  undo: { key: "z", ctrl: true },
  redo: { key: "y", ctrl: true },
  zoomIn: { key: "=", ctrl: true },
  zoomOut: { key: "-", ctrl: true },
  zoomReset: { key: "0", ctrl: true },
  playPause: { key: " ", ctrl: false },
  loadPng: { key: "l", ctrl: false },
  downloadPng: { key: "k", ctrl: false },
  guardarPlantilla: { key: "g", ctrl: false },
  misPlantillas: { key: "m", ctrl: false },
  realce: { key: "r", ctrl: false },
  ajustarMascara: { key: "a", ctrl: false },
};
const ATAJOS_LABELS = {
  brush: "Pincel",
  eraser: "Goma",
  hand: "Mano (pan)",
  brushSmaller: "Pincel mas chico",
  brushBigger: "Pincel mas grande",
  hardnessSmaller: "Dureza -",
  hardnessBigger: "Dureza +",
  rotateLeft: "Rotar a la izquierda",
  rotateRight: "Rotar a la derecha",
  undo: "Deshacer",
  redo: "Rehacer",
  zoomIn: "Acercar",
  zoomOut: "Alejar",
  zoomReset: "Ajustar zoom",
  playPause: "Reproducir / pausar",
  loadPng: "Cargar PNG",
  downloadPng: "Bajar mascara como PNG",
  guardarPlantilla: "Guardar como plantilla",
  misPlantillas: "Mis plantillas guardadas",
  realce: "Resaltar",
  ajustarMascara: "Ajustar mascara cargada",
};
let atajos = JSON.parse(JSON.stringify(ATAJOS_DEFAULT));
try {
  const guardados = JSON.parse(localStorage.getItem("clipxel_atajos") || "{}");
  Object.keys(ATAJOS_DEFAULT).forEach((accion) => { if (guardados[accion]) atajos[accion] = guardados[accion]; });
} catch (e) { /* localStorage corrupto: se queda con los defaults */ }

function guardarAtajos() {
  localStorage.setItem("clipxel_atajos", JSON.stringify(atajos));
}
function restablecerAtajos() {
  atajos = JSON.parse(JSON.stringify(ATAJOS_DEFAULT));
  guardarAtajos();
}
function coincideAtajo(e, combo) {
  return e.key.toLowerCase() === combo.key.toLowerCase()
    && (e.ctrlKey || e.metaKey) === !!combo.ctrl
    && e.shiftKey === !!combo.shift;
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Alt" && state.tool === "brush" && !state.altErasing) {
    state.altErasing = true;
    actualizarCursorPincel();
  }

  if (state.step !== 1) return;
  const escribiendo = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
  if (escribiendo) return;

  if (coincideAtajo(e, atajos.playPause)) { e.preventDefault(); if (videoFrame.paused) videoFrame.play(); else videoFrame.pause(); return; }
  if (coincideAtajo(e, atajos.undo)) { e.preventDefault(); deshacer(); return; }
  if (coincideAtajo(e, atajos.redo)) { e.preventDefault(); rehacer(); return; }
  if (coincideAtajo(e, atajos.zoomIn)) { e.preventDefault(); cambiarZoom(0.2); return; }
  if (coincideAtajo(e, atajos.zoomOut)) { e.preventDefault(); cambiarZoom(-0.2); return; }
  if (coincideAtajo(e, atajos.zoomReset)) { e.preventDefault(); fitCanvasToViewport(); return; }
  if (coincideAtajo(e, atajos.rotateLeft)) { document.getElementById("btnRotateLeft").click(); return; }
  if (coincideAtajo(e, atajos.rotateRight)) { document.getElementById("btnRotateRight").click(); return; }
  if (coincideAtajo(e, atajos.loadPng)) { document.getElementById("btnLoadPng").click(); return; }
  if (coincideAtajo(e, atajos.downloadPng)) { document.getElementById("btnBajarPng").click(); return; }
  if (coincideAtajo(e, atajos.guardarPlantilla)) { document.getElementById("btnGuardarPlantilla").click(); return; }
  if (coincideAtajo(e, atajos.misPlantillas)) { document.getElementById("btnMisPlantillas").click(); return; }
  if (coincideAtajo(e, atajos.realce)) { document.getElementById("btnRealce").click(); return; }
  if (coincideAtajo(e, atajos.ajustarMascara)) { document.getElementById("btnAjustarMascara").click(); return; }
  if (coincideAtajo(e, atajos.brush)) { setTool("brush"); return; }
  if (coincideAtajo(e, atajos.eraser)) { setTool("eraser"); return; }
  if (coincideAtajo(e, atajos.hand)) { setTool("hand"); return; }
  if (coincideAtajo(e, atajos.hardnessSmaller)) { setHardness(state.hardness - 10); return; }
  if (coincideAtajo(e, atajos.hardnessBigger)) { setHardness(state.hardness + 10); return; }
  if (coincideAtajo(e, atajos.brushSmaller)) { setBrushSize(state.brushSize - 4); return; }
  if (coincideAtajo(e, atajos.brushBigger)) { setBrushSize(state.brushSize + 4); return; }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Alt" && state.altErasing) {
    state.altErasing = false;
    actualizarCursorPincel();
  }
});
// Si la ventana pierde el foco con Alt apretado (ej. alt-tab), el keyup de
// Alt nunca llega -- sin esto el pincel se quedaba "pegado" en modo borrar.
window.addEventListener("blur", () => {
  if (state.altErasing) { state.altErasing = false; actualizarCursorPincel(); }
});

/* ---------------- Modal para reasignar atajos de teclado ---------------- */
const atajosOverlay = document.getElementById("atajosOverlay");
const atajosList = document.getElementById("atajosList");

function nombreTeclaSimple(tecla) {
  if (tecla === " ") return "Espacio";
  if (tecla === "[") return "[";
  if (tecla === "]") return "]";
  return tecla.toUpperCase();
}
function nombreCombo(combo) {
  const partes = [];
  if (combo.ctrl) partes.push("Ctrl");
  if (combo.shift) partes.push("Shift");
  partes.push(nombreTeclaSimple(combo.key));
  return partes.join("+");
}
function combosIguales(a, b) {
  return a.key.toLowerCase() === b.key.toLowerCase() && !!a.ctrl === !!b.ctrl && !!a.shift === !!b.shift;
}

function pintarAtajos() {
  atajosList.innerHTML = "";
  Object.keys(ATAJOS_DEFAULT).forEach((accion) => {
    const row = document.createElement("div");
    row.className = "plantilla-row";
    row.innerHTML = `
      <div><div class="plantilla-nombre">${ATAJOS_LABELS[accion]}</div></div>
      <button class="dispositivo-cerrar" data-accion="${accion}" style="min-width:60px">${nombreCombo(atajos[accion])}</button>
    `;
    atajosList.appendChild(row);
  });

  atajosList.querySelectorAll("button[data-accion]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const accion = btn.dataset.accion;
      const anterior = btn.textContent;
      btn.textContent = "...";
      const capturar = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
        const nuevo = { key: e.key.toLowerCase(), ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
        const enUso = Object.keys(atajos).find((a) => a !== accion && combosIguales(atajos[a], nuevo));
        if (enUso) {
          alert(`Ese atajo ya lo usa "${ATAJOS_LABELS[enUso]}". Elegí otro.`);
          btn.textContent = anterior;
        } else {
          atajos[accion] = nuevo;
          guardarAtajos();
          btn.textContent = nombreCombo(nuevo);
        }
        window.removeEventListener("keydown", capturar, true);
      };
      window.addEventListener("keydown", capturar, true);
    });
  });
}

document.getElementById("btnAbrirAtajos").addEventListener("click", () => {
  pintarAtajos();
  atajosOverlay.classList.add("open");
});
document.getElementById("atajosClose").addEventListener("click", () => atajosOverlay.classList.remove("open"));
document.getElementById("atajosListo").addEventListener("click", () => atajosOverlay.classList.remove("open"));
atajosOverlay.addEventListener("click", (e) => { if (e.target === atajosOverlay) atajosOverlay.classList.remove("open"); });
document.getElementById("atajosRestablecer").addEventListener("click", () => {
  restablecerAtajos();
  pintarAtajos();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "F9") {
    const info = {
      windowPywebview: !!window.pywebview,
      apiExists: !!(window.pywebview && window.pywebview.api),
      metodos: window.pywebview && window.pywebview.api ? Object.keys(window.pywebview.api) : [],
      apiEsMock: api === mockApi,
    };
    console.log("DIAG_F9", JSON.stringify(info));
    document.getElementById("lblClips").textContent = JSON.stringify(info);
  }
});

renderSteps();
mostrarPaso(0);
