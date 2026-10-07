/* Visor de relevamiento de paradas — Leaflet 1.9.4
 * Datos: data/lineas.geojson y data/paradas.geojson (generados con scripts/kmz_a_geojson.mjs)
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------- Config
  const ZOOM_ETIQUETAS = 15;        // a partir de este zoom se ven los números
  const RADIO_CERCANAS_M = 25;      // paradas agrupadas en el popup
  const RASTRO_MIN_M = 8;           // distancia mínima entre puntos del rastro
  const RASTRO_MAX_PRECISION_M = 40;
  const GPS_VIEJO_S = 15;           // segundos sin actualizar => aviso

  // Un color por línea (modo "todas"); tonos medios, visibles en modo claro, oscuro y satélite
  const PALETA = [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#ab47bc", "#00a5c4", "#f032e6",
    "#9a6324", "#469990", "#c62828", "#9e9d24", "#5c6bc0", "#e0b000", "#7cb342",
    "#ff6f91", "#00a86b", "#c71585", "#1e90ff", "#7e57c2", "#b15928", "#78909c",
  ];
  // Un color por sentido (cuando se elige una línea)
  const COLORES_SENTIDO = ["#ff3d00", "#2962ff", "#aa00ff", "#00a86b"];

  // ---------------------------------------------------------------- Utilidades
  const $ = (s) => document.querySelector(s);
  const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
  const leer = (k, def) => {
    try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (_) { return def; }
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Distancia aproximada en metros (equirectangular; sobra para escala urbana)
  function distM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
    const y = (b.lat - a.lat) * rad;
    return Math.sqrt(x * x + y * y) * R;
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`);
  const ordenLinea = (a, b) => a.localeCompare(b, "es", { numeric: true });
  const numeroParada = (nombre) => (nombre.match(/^\s*(\d+)/)?.[1] ?? nombre.slice(0, 10));

  // ---------------------------------------------------------------- Estado
  const prefiereOscuro = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const estado = {
    linea: leer("visor.linea", "todas"),
    base: leer("visor.base", "mapa"),
    tema: leer("visor.tema", prefiereOscuro ? "oscuro" : "claro"),
    capas: Object.assign({ recorridos: true, paradas: true, etiquetas: true, rastro: true }, leer("visor.capas", {})),
    ocultos: new Set(),             // archivos (sentidos) ocultos en la leyenda
  };

  // ---------------------------------------------------------------- Mapa
  const mapa = L.map("mapa", {
    center: [-45.865, -67.49], zoom: 13, maxZoom: 20,
    zoomControl: false, preferCanvas: true, tap: false,
  });
  mapa.attributionControl.setPrefix(false);

  const ATRIB_IGN = '<a href="https://www.ign.gob.ar/" target="_blank" rel="noopener">IGN</a> Argenmap';
  const BASES = {
    mapa: L.tileLayer(
      "https://wms.ign.gob.ar/geoserver/gwc/service/tms/1.0.0/capabaseargenmap@EPSG:3857@png/{z}/{x}/{-y}.png",
      { maxZoom: 20, maxNativeZoom: 19, attribution: ATRIB_IGN }
    ),
    mapaOscuro: L.tileLayer(
      "https://wms.ign.gob.ar/geoserver/gwc/service/tms/1.0.0/argenmap_oscuro@EPSG:3857@png/{z}/{x}/{-y}.png",
      { maxZoom: 20, maxNativeZoom: 19, attribution: ATRIB_IGN }
    ),
    satelite: L.tileLayer(
      "https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
      { subdomains: "0123", maxZoom: 20, maxNativeZoom: 20, attribution: "Imágenes © Google" }
    ),
  };

  // "mapa" usa Argenmap claro u oscuro según el tema
  function ponerBase(nombre) {
    if (nombre !== "mapa" && nombre !== "satelite") nombre = "mapa";
    const clave = nombre === "mapa" && estado.tema === "oscuro" ? "mapaOscuro" : nombre;
    Object.entries(BASES).forEach(([k, capa]) => { if (k !== clave) mapa.removeLayer(capa); });
    BASES[clave].addTo(mapa);
    estado.base = nombre;
    guardar("visor.base", nombre);
    document.querySelectorAll(".segmentado button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.base === nombre)));
  }

  function ponerTema(tema) {
    estado.tema = tema === "oscuro" ? "oscuro" : "claro";
    guardar("visor.tema", estado.tema);
    document.documentElement.dataset.tema = estado.tema;
    document.querySelector('meta[name="theme-color"]').content = estado.tema === "oscuro" ? "#0b0f14" : "#1b2a3a";
    $("#btn-tema").setAttribute("aria-label", estado.tema === "oscuro" ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
    ponerBase(estado.base);
  }

  // Panes con canvas propio: el orden de los panes asegura que las paradas
  // queden siempre por encima de los recorridos (dentro de un mismo canvas,
  // lo último dibujado tapa a lo anterior).
  const capaEn = (nombre, z) => {
    mapa.createPane(nombre).style.zIndex = z;
    return { pane: nombre, renderer: L.canvas({ pane: nombre, padding: 0.3 }) };
  };
  const EN_RECORRIDOS = capaEn("pRecorridos", 410);
  const EN_RASTRO = capaEn("pRastro", 420);
  const EN_PARADAS = capaEn("pParadas", 430);

  const grupoRecorridos = L.layerGroup().addTo(mapa);
  const grupoParadas = L.layerGroup().addTo(mapa);
  const grupoRastro = L.layerGroup().addTo(mapa);
  const grupoYo = L.layerGroup().addTo(mapa);

  // ---------------------------------------------------------------- Datos
  let recorridos = [];   // { archivo, linea, recorrido, latlngs[][], paradas[] }
  let todasParadas = []; // { latlng, linea, recorrido, archivo, nombre }
  let paradasVisibles = [];
  const colorLinea = {};

  async function cargarDatos() {
    const [lin, par] = await Promise.all([
      fetch("data/lineas.geojson").then((r) => r.json()),
      fetch("data/paradas.geojson").then((r) => r.json()),
    ]);
    const porArchivo = new Map();
    const obtener = (p) => {
      if (!porArchivo.has(p.archivo)) porArchivo.set(p.archivo, { archivo: p.archivo, linea: p.linea, recorrido: p.recorrido, latlngs: [], paradas: [] });
      return porArchivo.get(p.archivo);
    };
    lin.features.forEach((f) => obtener(f.properties).latlngs.push(f.geometry.coordinates.map(([x, y]) => [y, x])));
    par.features.forEach((f) => {
      const [x, y] = f.geometry.coordinates;
      const p = { ...f.properties, latlng: L.latLng(y, x) };
      obtener(p).paradas.push(p);
      todasParadas.push(p);
    });
    recorridos = [...porArchivo.values()].sort((a, b) => ordenLinea(a.linea, b.linea) || a.recorrido.localeCompare(b.recorrido, "es"));
    const lineas = [...new Set(recorridos.map((r) => r.linea))].sort(ordenLinea);
    lineas.forEach((l, i) => { colorLinea[l] = PALETA[i % PALETA.length]; });

    const sel = $("#sel-linea");
    lineas.forEach((l) => {
      const n = recorridos.filter((r) => r.linea === l).reduce((s, r) => s + r.paradas.length, 0);
      sel.add(new Option(`Línea ${l} (${n})`, l));
    });
    if (estado.linea !== "todas" && !lineas.includes(estado.linea)) estado.linea = "todas";
    sel.value = estado.linea;
  }

  // ---------------------------------------------------------------- Dibujo
  const recorridosDeLinea = () => (estado.linea === "todas" ? recorridos : recorridos.filter((r) => r.linea === estado.linea));
  const colorDe = (r) => (estado.linea === "todas" ? colorLinea[r.linea] : COLORES_SENTIDO[recorridosDeLinea().indexOf(r) % COLORES_SENTIDO.length]);

  function dibujar() {
    grupoRecorridos.clearLayers();
    grupoParadas.clearLayers();
    paradasVisibles = [];
    const unaLinea = estado.linea !== "todas";

    recorridosDeLinea().forEach((r) => {
      if (estado.ocultos.has(r.archivo)) return;
      const color = colorDe(r);
      if (estado.capas.recorridos && r.latlngs.length) {
        const borde = estado.tema === "oscuro" ? "#000" : "#fff";
        if (unaLinea) L.polyline(r.latlngs, { ...EN_RECORRIDOS, color: borde, weight: 8, opacity: 0.7, interactive: false }).addTo(grupoRecorridos);
        L.polyline(r.latlngs, { ...EN_RECORRIDOS, color, weight: unaLinea ? 4.5 : 3, opacity: unaLinea ? 0.95 : 0.65, interactive: false }).addTo(grupoRecorridos);
      }
      r.paradas.forEach((p) => {
        paradasVisibles.push(p);
        if (!estado.capas.paradas) return;
        const m = L.circleMarker(p.latlng, {
          ...EN_PARADAS, radius: unaLinea ? 7 : 5, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1,
        }).addTo(grupoParadas);
        m.on("click", () => abrirPopup(p));
        if (unaLinea && estado.capas.etiquetas) {
          m.bindTooltip(esc(numeroParada(p.nombre)), { permanent: true, direction: "right", offset: [7, 0], className: "etiqueta", interactive: false });
        }
      });
    });
    dibujarLeyenda();
    actualizarCercana();
  }

  function dibujarLeyenda() {
    const ley = $("#leyenda");
    if (estado.linea === "todas") { ley.hidden = true; ley.innerHTML = ""; return; }
    ley.innerHTML = "";
    recorridosDeLinea().forEach((r) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-pressed", String(!estado.ocultos.has(r.archivo)));
      b.innerHTML = `<span class="muestra" style="background:${colorDe(r)}"></span>
        <span class="nombre">${esc(r.recorrido)}</span>
        <span class="cant">${r.paradas.length}</span>`;
      b.addEventListener("click", () => {
        estado.ocultos.has(r.archivo) ? estado.ocultos.delete(r.archivo) : estado.ocultos.add(r.archivo);
        dibujar();
      });
      ley.appendChild(b);
    });
    ley.hidden = false;
  }

  function encuadrarLinea() {
    const pts = recorridosDeLinea().flatMap((r) => [...r.latlngs.flat(), ...r.paradas.map((p) => p.latlng)]);
    if (!pts.length) return;
    const pad = window.innerWidth < 600 ? [24, 24] : [60, 60];
    mapa.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [pad[0], 130], paddingBottomRight: [pad[1], 90] });
  }

  function abrirPopup(p) {
    const cerca = todasParadas
      .map((q) => ({ q, d: distM(p.latlng, q.latlng) }))
      .filter(({ d }) => d <= RADIO_CERCANAS_M)
      .sort((a, b) => ordenLinea(a.q.linea, b.q.linea) || a.d - b.d);
    const items = cerca.map(({ q }) => {
      const color = estado.linea === "todas" || q.linea !== estado.linea ? colorLinea[q.linea] : colorDe(recorridos.find((r) => r.archivo === q.archivo));
      return `<li><span class="chip" style="background:${color}">${esc(q.linea)}</span>
        <span><b>${esc(q.nombre)}</b><br><span class="det">${esc(q.recorrido)}</span></span></li>`;
    }).join("");
    const titulo = cerca.length > 1 ? `${cerca.length} paradas en este punto` : "Parada";
    L.popup({ maxWidth: 300, autoPanPaddingTopLeft: [10, 120] })
      .setLatLng(p.latlng)
      .setContent(`<div class="popup-titulo">${titulo}</div><ul class="popup-lista">${items}</ul>
        <div class="popup-coord">${p.latlng.lat.toFixed(6)}, ${p.latlng.lng.toFixed(6)}</div>`)
      .openOn(mapa);
  }

  function actualizarClaseZoom() {
    mapa.getContainer().classList.toggle("zoom-bajo", mapa.getZoom() < ZOOM_ETIQUETAS);
  }

  // ---------------------------------------------------------------- GPS
  let watchId = null;
  let ultimaPos = null;     // { latlng, precision, velocidad, rumbo, t }
  let siguiendo = false;
  let primerFix = true;
  let wakeLock = null;
  const marcadorYo = L.marker([0, 0], {
    icon: L.divIcon({ className: "yo", html: '<div class="yo-flecha"></div><div class="yo-punto"></div>', iconSize: [28, 28], iconAnchor: [14, 14] }),
    interactive: false, keyboard: false, zIndexOffset: 1000,
  });
  const circuloPrecision = L.circle([0, 0], { ...EN_RASTRO, radius: 1, color: "#1a73e8", weight: 1, fillColor: "#1a73e8", fillOpacity: 0.12, interactive: false });

  function ponerBotonUbicar() {
    const b = $("#btn-ubicar");
    b.classList.toggle("apagado", watchId == null);
    b.classList.toggle("activo", watchId != null && !siguiendo);
    b.classList.toggle("siguiendo", watchId != null && siguiendo);
    b.setAttribute("aria-label", watchId == null ? "Activar ubicación y seguirme" : siguiendo ? "Siguiendo mi ubicación" : "Volver a seguirme");
  }

  function setSiguiendo(v) {
    siguiendo = v;
    ponerBotonUbicar();
    if (v && ultimaPos) mapa.panTo(ultimaPos.latlng, { animate: true });
  }

  function textoGPS(msg, viejo = false) {
    const el = $("#estado-gps");
    el.textContent = msg;
    el.classList.toggle("viejo", viejo);
  }

  function iniciarGPS() {
    if (!("geolocation" in navigator)) { textoGPS("Este navegador no tiene geolocalización", true); return; }
    if (!window.isSecureContext) { textoGPS("La ubicación necesita HTTPS (GitHub Pages) o localhost", true); return; }
    textoGPS("Buscando señal GPS…");
    watchId = navigator.geolocation.watchPosition(alRecibirPos, alFallarPos, {
      enableHighAccuracy: true, maximumAge: 1000, timeout: 20000,
    });
    setSiguiendo(true);
    pedirWakeLock();
  }

  function alRecibirPos(pos) {
    const c = pos.coords;
    const latlng = L.latLng(c.latitude, c.longitude);
    ultimaPos = { latlng, precision: c.accuracy, velocidad: c.speed, rumbo: c.heading, t: Date.now() };

    marcadorYo.setLatLng(latlng).addTo(grupoYo);
    circuloPrecision.setLatLng(latlng).setRadius(c.accuracy).addTo(grupoYo);
    const el = marcadorYo.getElement();
    if (el) {
      const conRumbo = c.heading != null && !Number.isNaN(c.heading) && (c.speed ?? 0) > 1.5;
      el.classList.toggle("con-rumbo", conRumbo);
      if (conRumbo) el.querySelector(".yo-flecha").style.transform = `rotate(${c.heading}deg)`;
    }

    if (primerFix) {
      primerFix = false;
      mapa.setView(latlng, Math.max(mapa.getZoom(), 17));
    } else if (siguiendo) {
      mapa.panTo(latlng, { animate: true, duration: 0.5 });
    }
    agregarAlRastro(latlng, c.accuracy);
    refrescarEstado();
    actualizarCercana();
  }

  function alFallarPos(err) {
    if (err.code === err.PERMISSION_DENIED) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      ponerBotonUbicar();
      textoGPS("Permiso de ubicación denegado: habilitalo en el navegador", true);
    } else if (!ultimaPos) {
      textoGPS("Sin señal GPS todavía…", true);
    }
  }

  function refrescarEstado() {
    if (!ultimaPos) return;
    const s = Math.round((Date.now() - ultimaPos.t) / 1000);
    const vel = ultimaPos.velocidad != null && !Number.isNaN(ultimaPos.velocidad) ? `${Math.round(ultimaPos.velocidad * 3.6)} km/h` : "— km/h";
    const hace = s <= 1 ? "ahora" : `hace ${s} s`;
    textoGPS(`±${Math.round(ultimaPos.precision)} m · ${vel} · ${hace}`, s > GPS_VIEJO_S);
  }

  function actualizarCercana() {
    const el = $("#estado-cercana");
    if (!ultimaPos || !paradasVisibles.length) { el.hidden = true; return; }
    let mejor = null, dMin = Infinity;
    for (const p of paradasVisibles) {
      const d = distM(ultimaPos.latlng, p.latlng);
      if (d < dMin) { dMin = d; mejor = p; }
    }
    el.textContent = `Más cercana: L${mejor.linea} · ${numeroParada(mejor.nombre)} · ${fmtDist(dMin)}`;
    el.hidden = false;
  }

  async function pedirWakeLock() {
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible" && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch (_) { /* no soportado o rechazado: no pasa nada */ }
  }

  // ---------------------------------------------------------------- Rastro del día
  const claveRastro = () => `visor.rastro.${new Date().toLocaleDateString("sv")}`; // AAAA-MM-DD local
  let rastro = leer(claveRastro(), []);
  let pendientesGuardar = 0;
  const lineaRastroFondo = L.polyline([], { ...EN_RASTRO, color: "#111", weight: 6, opacity: 0.45, interactive: false });
  const lineaRastro = L.polyline([], { ...EN_RASTRO, color: "#fff", weight: 3, opacity: 0.95, dashArray: "6 6", interactive: false });

  function dibujarRastro() {
    grupoRastro.clearLayers();
    if (!estado.capas.rastro) return;
    lineaRastroFondo.setLatLngs(rastro).addTo(grupoRastro);
    lineaRastro.setLatLngs(rastro).addTo(grupoRastro);
  }

  function agregarAlRastro(latlng, precision) {
    if (precision > RASTRO_MAX_PRECISION_M) return;
    const ult = rastro[rastro.length - 1];
    if (ult && distM(L.latLng(ult), latlng) < RASTRO_MIN_M) return;
    rastro.push([+latlng.lat.toFixed(6), +latlng.lng.toFixed(6)]);
    if (rastro.length > 30000) rastro.shift();
    if (estado.capas.rastro) { lineaRastroFondo.addLatLng(latlng); lineaRastro.addLatLng(latlng); }
    if (++pendientesGuardar >= 5) { guardar(claveRastro(), rastro); pendientesGuardar = 0; }
  }

  // ---------------------------------------------------------------- Eventos UI
  function enlazarUI() {
    $("#sel-linea").addEventListener("change", (e) => {
      estado.linea = e.target.value;
      estado.ocultos.clear();
      guardar("visor.linea", estado.linea);
      mapa.closePopup();
      dibujar();
      setSiguiendo(false);
      if (estado.linea !== "todas") encuadrarLinea();
    });

    document.querySelectorAll(".segmentado button").forEach((b) => b.addEventListener("click", () => ponerBase(b.dataset.base)));

    const panel = $("#panel-capas"), btnCapas = $("#btn-capas");
    btnCapas.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      btnCapas.setAttribute("aria-expanded", String(!panel.hidden));
    });
    mapa.on("click", () => { panel.hidden = true; btnCapas.setAttribute("aria-expanded", "false"); });

    $("#btn-tema").addEventListener("click", () => {
      ponerTema(estado.tema === "oscuro" ? "claro" : "oscuro");
      dibujar();
    });

    panel.querySelectorAll("input[data-capa]").forEach((inp) => {
      inp.checked = !!estado.capas[inp.dataset.capa];
      inp.addEventListener("change", () => {
        estado.capas[inp.dataset.capa] = inp.checked;
        guardar("visor.capas", estado.capas);
        if (inp.dataset.capa === "rastro") dibujarRastro(); else dibujar();
      });
    });
    $("#btn-borrar-rastro").addEventListener("click", () => {
      if (!confirm("¿Borrar el recorrido de hoy guardado en este teléfono?")) return;
      rastro = [];
      guardar(claveRastro(), rastro);
      dibujarRastro();
    });

    $("#btn-ubicar").addEventListener("click", () => {
      if (watchId == null) iniciarGPS();
      else setSiguiendo(true);
    });
    mapa.on("dragstart", () => { if (siguiendo) setSiguiendo(false); });
    mapa.on("zoomend", actualizarClaseZoom);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { if (watchId != null) pedirWakeLock(); }
      else if (pendientesGuardar) { guardar(claveRastro(), rastro); pendientesGuardar = 0; }
    });
    setInterval(refrescarEstado, 1000);
  }

  // ---------------------------------------------------------------- Inicio
  ponerTema(estado.tema);
  actualizarClaseZoom();
  enlazarUI();
  dibujarRastro();
  cargarDatos()
    .then(() => {
      dibujar();
      if (estado.linea !== "todas") encuadrarLinea();
      else {
        const b = L.latLngBounds(todasParadas.map((p) => p.latlng));
        if (b.isValid()) mapa.fitBounds(b, { paddingTopLeft: [10, 70], paddingBottomRight: [10, 80] });
      }
    })
    .catch((e) => {
      console.error(e);
      textoGPS("No se pudieron cargar los datos (¿abriste el archivo sin servidor?)", true);
    });
})();
