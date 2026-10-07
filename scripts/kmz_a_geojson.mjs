// kmz_a_geojson.mjs
// Convierte los .kmz/.kml de ../kml_crudos en dos GeoJSON para el visor:
//   data/lineas.geojson  -> recorridos (LineString), uno por archivo
//   data/paradas.geojson -> paradas (Point) con la línea y el recorrido al que pertenecen
//
// Uso (desde transporte_octubre/):
//   node scripts/kmz_a_geojson.mjs
//
// Sin dependencias: lee el ZIP del .kmz con zlib de Node.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRADA = join(RAIZ, "kml_crudos");
const SALIDA = join(RAIZ, "data");

// Archivos que no se publican (versiones reemplazadas por otra más nueva).
const EXCLUIR = new Set([
  "L 5 U IyV OK corta.kmz", // reemplazado por "L 5 U IyV OK corta 02-10-2026.kmz"
]);

const DECIMALES = 6; // ~0,1 m

// --- ZIP mínimo (solo lo necesario para un .kmz) ---------------------------
function leerKmlDeKmz(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP inválido");
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < total; n++) {
    const metodo = buf.readUInt16LE(p + 10);
    const tamComp = buf.readUInt32LE(p + 20);
    const largoNombre = buf.readUInt16LE(p + 28);
    const largoExtra = buf.readUInt16LE(p + 30);
    const largoComent = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.toString("utf8", p + 46, p + 46 + largoNombre);
    p += 46 + largoNombre + largoExtra + largoComent;
    if (!nombre.toLowerCase().endsWith(".kml")) continue;
    const inicio = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const datos = buf.subarray(inicio, inicio + tamComp);
    return (metodo === 8 ? inflateRawSync(datos) : datos).toString("utf8");
  }
  throw new Error("El KMZ no contiene un .kml");
}

// --- KML -> features ------------------------------------------------------
const redondear = (v) => Math.round(v * 10 ** DECIMALES) / 10 ** DECIMALES;

function parsearCoords(txt) {
  return txt.trim().split(/\s+/).map((t) => {
    const [lon, lat] = t.split(",").map(Number);
    return [redondear(lon), redondear(lat)];
  }).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

const decodificar = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

// "L 1 Centro - Abasolo OK" -> { linea: "1", recorrido: "Centro - Abasolo" }
function datosDeArchivo(archivo) {
  const base = basename(archivo, extname(archivo));
  const m = base.match(/^L\s*(\d+)(?:\s+(U)\b)?\s*(.*)$/i);
  if (!m) return { linea: base, recorrido: base };
  const linea = m[1] + (m[2] ? m[2].toUpperCase() : "");
  const recorrido = m[3].replace(/\s*ok\s*$/i, "").replace(/\s+/g, " ").trim() || base;
  return { linea, recorrido };
}

const lineas = [];
const paradas = [];
const resumen = [];

const archivos = readdirSync(ENTRADA)
  .filter((f) => /\.km[lz]$/i.test(f) && !EXCLUIR.has(f))
  .sort((a, b) => a.localeCompare(b, "es", { numeric: true }));

for (const archivo of archivos) {
  const buf = readFileSync(join(ENTRADA, archivo));
  const kml = archivo.toLowerCase().endsWith(".kmz") ? leerKmlDeKmz(buf) : buf.toString("utf8");
  const { linea, recorrido } = datosDeArchivo(archivo);
  let nP = 0, nL = 0;

  for (const [, pm] of kml.matchAll(/<Placemark[\s>]([\s\S]*?)<\/Placemark>/g)) {
    const nombre = decodificar(pm.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? "");
    // Recorridos: LineString, o el contorno de un Polygon (ej. L 5 U, dibujado como circuito cerrado)
    const recorridos = [
      ...pm.matchAll(/<LineString[\s>][\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g),
      ...pm.matchAll(/<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g),
    ];
    for (const [, c] of recorridos) {
      const coords = parsearCoords(c);
      if (coords.length < 2) continue;
      lineas.push({
        type: "Feature",
        properties: { linea, recorrido, archivo },
        geometry: { type: "LineString", coordinates: coords },
      });
      nL++;
    }
    const pt = pm.match(/<Point[\s>][\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/);
    if (pt) {
      const [coord] = parsearCoords(pt[1]);
      if (!coord) continue;
      paradas.push({
        type: "Feature",
        properties: { linea, recorrido, archivo, nombre },
        geometry: { type: "Point", coordinates: coord },
      });
      nP++;
    }
  }
  resumen.push(`${archivo.padEnd(52)} línea ${linea.padEnd(4)} paradas ${String(nP).padStart(3)}  recorridos ${nL}`);
}

mkdirSync(SALIDA, { recursive: true });
const fc = (features) => JSON.stringify({ type: "FeatureCollection", features });
writeFileSync(join(SALIDA, "lineas.geojson"), fc(lineas));
writeFileSync(join(SALIDA, "paradas.geojson"), fc(paradas));

console.log(resumen.join("\n"));
console.log(`\n${archivos.length} archivos -> ${lineas.length} recorridos, ${paradas.length} paradas`);
if (EXCLUIR.size) console.log(`Excluidos: ${[...EXCLUIR].join(", ")}`);
