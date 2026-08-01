// Build the static dataset for researched localities:
//  - walk/<slug>.json  : pre-analyzed promenade results (instant Walk areas)
//  - gems/<slug>.json  : enriched with per-place lat/lon (instant pins)
// Run: node tools/build-static.mjs [--force] [slug-filter…]
// Respects Nominatim 1 req/s; Overpass via honest UA with mirror fallback.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Promenade = require('../promenade.js');

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const GEMS = path.join(ROOT, 'gems');
const WALK = path.join(ROOT, 'walk');
fs.mkdirSync(WALK, { recursive: true });

const UA = 'PromenadeFinder/1.0 (+https://georgeolaru.com/public/promenade-finder/)';
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const MAX_SPAN_DEG = 0.09;
const FORCE = process.argv.includes('--force');
const FILTERS = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastNominatim = 0;
async function nominatim(params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastNominatim = Date.now();
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&' + params,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return [];
      return await r.json();
    } catch (e) {
      console.log('    nominatim retry (' + e.code || e.message + ')');
      await sleep(4000);
    }
  }
  return [];
}

function pickLocality(list) {
  const LOC = /^(city|town|village|municipality|hamlet|borough|suburb|quarter|neighbourhood)$/;
  const REG = /^(county|state|region|province|district)$/;
  return list.find((r) => LOC.test(r.addresstype || '') && r.osm_type === 'relation')
    || list.find((r) => LOC.test(r.addresstype || ''))
    || list.find((r) => r.osm_type === 'relation' && r.category === 'boundary' && !REG.test(r.addresstype || ''))
    || list.find((r) => (r.category === 'place' || r.category === 'boundary') && !REG.test(r.addresstype || ''))
    || list[0];
}

function buildQuery(place) {
  const bb = place.boundingbox.map(Number);
  let [s, n, w, e] = [bb[0], bb[1], bb[2], bb[3]];
  const lat = Number(place.lat), lon = Number(place.lon);
  let clamped = false;
  if (n - s > MAX_SPAN_DEG) { s = lat - MAX_SPAN_DEG / 2; n = lat + MAX_SPAN_DEG / 2; clamped = true; }
  if (e - w > MAX_SPAN_DEG * 1.4) { w = lon - MAX_SPAN_DEG * 0.7; e = lon + MAX_SPAN_DEG * 0.7; clamped = true; }
  const bbox = [s, w, n, e].join(',');
  const areaFilter = place.osm_type === 'relation' ? `area(${3600000000 + place.osm_id})->.a;` : '';
  const inArea = areaFilter ? '(area.a)' : '';
  const q = `[out:json][timeout:90][bbox:${bbox}];\n${areaFilter}(\n` +
    `  way["highway"~"^(pedestrian|living_street)$"]${inArea};\n` +
    `  way["highway"~"^(footway|path)$"]["name"]${inArea};\n` +
    `  way["place"="square"]${inArea};\n  node["place"="square"]${inArea};\n` +
    `  way["natural"="beach"]${inArea};\n  way["man_made"="pier"]${inArea};\n` +
    `  way["leisure"~"^(marina|park|garden|water_park|beach_resort|swimming_area|recreation_ground)$"]${inArea};\n` +
    `  way["landuse"="recreation_ground"]${inArea};\n);\nout tags geom;\n` +
    `way["leisure"~"^(park|garden|water_park|beach_resort|recreation_ground)$"]${inArea};\n` +
    `map_to_area ->.parkareas;\nway["highway"~"^(footway|path)$"](area.parkareas);\nout tags geom;\n(\n` +
    `  node["amenity"~"^(cafe|restaurant|bar|pub|ice_cream|biergarten|fast_food)$"]${inArea};\n` +
    `  way["amenity"~"^(cafe|restaurant|bar|pub|ice_cream|biergarten|fast_food)$"]${inArea};\n` +
    `  node["amenity"="fountain"]${inArea};\n  node["leisure"="bandstand"]${inArea};\n` +
    `  node["leisure"="playground"]${inArea};\n  way["leisure"="playground"]${inArea};\n` +
    `  node["amenity"~"^(bench|drinking_water)$"]${inArea};\n` +
    `  node["tourism"~"^(attraction|artwork|viewpoint)$"]${inArea};\n);\nout tags center;`;
  return { q, clamped };
}

async function overpass(q) {
  for (let round = 0; round < 2; round++) {
    for (const m of MIRRORS) {
      try {
        const r = await fetch(m, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body: 'data=' + encodeURIComponent(q),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) {
        console.log('    mirror failed:', m.split('/')[2], e.message);
        await sleep(3000);
      }
    }
  }
  throw new Error('all mirrors failed');
}

function analyzeOpts(place) {
  if (place.osm_type === 'relation') return {};
  const t = place.addresstype || place.type || '';
  const maxKm = /hamlet|isolated_dwelling/.test(t) ? 1.2 :
    /village|suburb|quarter|neighbourhood/.test(t) ? 2.0 : /town/.test(t) ? 3.5 : 5.0;
  return { center: [Number(place.lat), Number(place.lon)], maxKm };
}

function geocodeCandidates(p, label) {
  const out = [{ q: p.name + ', ' + label, approx: false }];
  const simplified = p.name.replace(/\(.*?\)/g, ' ')
    .replace(/\b(hotel|restaurant|pensiunea?|terasa|cafeneaua|cofet[ăa]ria|bistro|pizzeria|patiseria|cherhanaua?|gastro\s*bar|events?)\b/gi, ' ')
    .replace(/[&·-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (simplified && simplified.toLowerCase() !== p.name.toLowerCase()) {
    out.push({ q: simplified + ', ' + label, approx: false });
  }
  if (p.area) {
    const street = p.area.replace(/\b(centru|center|central[ăa]?|zona)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (street) out.push({ q: street + ', ' + label, approx: true });
  }
  return out;
}

const index = JSON.parse(fs.readFileSync(path.join(GEMS, 'index.json'), 'utf8'));
for (const locEntry of index.localities) {
  if (FILTERS.length && !FILTERS.some((f) => locEntry.slug.includes(f))) continue;
  console.log('=== ' + locEntry.label + ' (' + locEntry.slug + ')');

  // 1) enrich gems with coordinates
  const gemFiles = [locEntry.slug + '.json'];
  const short = locEntry.slug.replace(/-romania$/, '').replace(/-(tulcea|constanta)$/, '');
  for (const v of [short + '.json', short + '-romania.json']) {
    if (!gemFiles.includes(v) && fs.existsSync(path.join(GEMS, v))) gemFiles.push(v);
  }
  const main = JSON.parse(fs.readFileSync(path.join(GEMS, gemFiles[0]), 'utf8'));
  let changed = false;
  for (const p of main.places) {
    if (p.lat && !FORCE) continue;
    for (const cand of geocodeCandidates(p, locEntry.label)) {
      const list = await nominatim('limit=1&q=' + encodeURIComponent(cand.q));
      if (list.length) {
        p.lat = Number(list[0].lat); p.lon = Number(list[0].lon); p.approx = cand.approx;
        changed = true;
        console.log('  pin ' + (cand.approx ? '≈ ' : '') + p.name);
        break;
      }
    }
    if (!p.lat) console.log('  pin MISS ' + p.name);
  }
  if (changed) {
    const out = JSON.stringify(main);
    for (const f of gemFiles) fs.writeFileSync(path.join(GEMS, f), out);
  }

  // 2) pre-analyze walk areas
  const walkFile = path.join(WALK, locEntry.slug + '.json');
  if (fs.existsSync(walkFile) && !FORCE) { console.log('  walk cached'); continue; }
  try {
    const list = await nominatim('limit=5&q=' + encodeURIComponent(locEntry.slug.replace(/-/g, ' ')));
    const place = pickLocality(list);
    if (!place) { console.log('  walk GEOCODE MISS'); continue; }
    const { q, clamped } = buildQuery(place);
    const data = await overpass(q);
    const result = Promenade.analyze(data.elements, analyzeOpts(place));
    const payload = {
      generatedAt: new Date().toISOString().slice(0, 10),
      clamped,
      place: {
        display_name: place.display_name, lat: place.lat, lon: place.lon,
        osm_type: place.osm_type, addresstype: place.addresstype,
      },
      result: { status: result.status, areas: result.areas },
    };
    fs.writeFileSync(walkFile, JSON.stringify(payload));
    for (const v of gemFiles.slice(1)) {
      fs.writeFileSync(path.join(WALK, v), JSON.stringify(payload));
    }
    console.log('  walk ' + result.status + ' (' + result.areas.length + ' areas, ' +
      data.elements.length + ' elements)');
    await sleep(2000);
  } catch (e) {
    console.log('  walk FAILED: ' + e.message);
  }
}
console.log('BUILD DONE');
