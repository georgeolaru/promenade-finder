// Calibration harness: runs the real pipeline (Nominatim -> Overpass -> analyze) for
// localities with known ground truth. Usage: node test/calibrate.js [name...]
'use strict';
const fs = require('fs');
const path = require('path');
const Promenade = require('../promenade.js');

// overpass-api.de rejects fake "Mozilla/5.0" curl UAs with 406 — an honest app UA works
const UA = 'PromenadeFinder/1.0 (+https://georgeolaru.com/public/promenade-finder/)';
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const CACHE = path.join(__dirname, 'cache');
const MAX_SPAN_DEG = 0.09;

const CASES = [
  { q: 'Sibiu, Romania', expect: 'strong', truth: 'Piața Mare / Strada Nicolae Bălcescu' },
  { q: 'Constanța, Romania', expect: 'strong', truth: 'seafront (Faleza / Cazino) or old town' },
  { q: 'Rășinari, Sibiu, Romania', expect: 'weak-or-none', truth: 'village, no formal promenade' },
  { q: 'Vama Veche, Romania', expect: 'strong-or-weak', truth: 'beach village, shore is the promenade' },
  // George's ground truth (2026-07-31): 1. Parc Central (near the Theatre),
  // 2. Ștrandul Tineretului, 3. Trei Căldări — and nothing else qualifies.
  { q: 'Piatra Neamț, Romania', expect: 'strong', truth: 'Parc Central, Ștrandul Tineretului, Trei Căldări' },
];

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return r.json();
}

function buildQuery(place) {
  // keep in sync with app.js buildQuery
  const bb = place.boundingbox.map(Number);
  let [s, n, w, e] = [bb[0], bb[1], bb[2], bb[3]];
  const lat = Number(place.lat), lon = Number(place.lon);
  let clamped = false;
  if (n - s > MAX_SPAN_DEG) { s = lat - MAX_SPAN_DEG / 2; n = lat + MAX_SPAN_DEG / 2; clamped = true; }
  if (e - w > MAX_SPAN_DEG * 1.4) { w = lon - MAX_SPAN_DEG * 0.7; e = lon + MAX_SPAN_DEG * 0.7; clamped = true; }
  const bbox = [s, w, n, e].join(',');
  // area filter only for relations (ways often have no Overpass area object)
  let areaFilter = '';
  if (place.osm_type === 'relation') areaFilter = `area(${3600000000 + place.osm_id})->.a;`;
  const inArea = areaFilter ? '(area.a)' : '';
  const q = `[out:json][timeout:90][bbox:${bbox}];\n${areaFilter}(\n` +
    `  way["highway"~"^(pedestrian|living_street)$"]${inArea};\n` +
    `  way["highway"~"^(footway|path)$"]["name"]${inArea};\n` +
    `  way["place"="square"]${inArea};\n` +
    `  node["place"="square"]${inArea};\n` +
    `  way["natural"="beach"]${inArea};\n` +
    `  way["man_made"="pier"]${inArea};\n` +
    `  way["leisure"~"^(marina|park|garden|water_park|beach_resort|swimming_area|recreation_ground)$"]${inArea};\n` +
    `  way["landuse"="recreation_ground"]${inArea};\n` +
    `);\nout tags geom;\n` +
    `way["leisure"~"^(park|garden|water_park|beach_resort|recreation_ground)$"]${inArea};\n` +
    `map_to_area ->.parkareas;\n` +
    `way["highway"~"^(footway|path)$"](area.parkareas);\n` +
    `out tags geom;\n(\n` +
    `  node["amenity"~"^(cafe|restaurant|bar|pub|ice_cream|biergarten|fast_food)$"]${inArea};\n` +
    `  way["amenity"~"^(cafe|restaurant|bar|pub|ice_cream|biergarten|fast_food)$"]${inArea};\n` +
    `  node["amenity"="fountain"]${inArea};\n` +
    `  node["leisure"="bandstand"]${inArea};\n` +
    `  node["tourism"~"^(attraction|artwork|viewpoint)$"]${inArea};\n` +
    `);\nout tags center;`;
  return q;
}

async function runCase(c) {
  fs.mkdirSync(CACHE, { recursive: true });
  const slug = c.q.toLowerCase().replace(/[^a-z]+/g, '-');
  const cacheFile = path.join(CACHE, slug + '.json');
  let data;
  if (fs.existsSync(cacheFile)) {
    data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } else {
    const list = await getJSON(
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' + encodeURIComponent(c.q),
      { headers: { 'User-Agent': 'promenade-finder-calibration' } });
    // keep in sync with app.js geocode(): locality over county/region
    const LOC = /^(city|town|village|municipality|hamlet|borough|suburb|quarter|neighbourhood)$/;
    const REG = /^(county|state|region|province|district)$/;
    const place = list.find(r => LOC.test(r.addresstype || '') && r.osm_type === 'relation')
      || list.find(r => LOC.test(r.addresstype || ''))
      || list.find(r => r.osm_type === 'relation' && r.category === 'boundary' && !REG.test(r.addresstype || ''))
      || list.find(r => (r.category === 'place' || r.category === 'boundary') && !REG.test(r.addresstype || ''))
      || list[0];
    if (!place) throw new Error('geocode miss: ' + c.q);
    const body = 'data=' + encodeURIComponent(buildQuery(place));
    let osm, lastErr;
    for (const mirror of [...MIRRORS, ...MIRRORS]) { // two passes over the mirror list
      try {
        osm = await getJSON(mirror, {
          method: 'POST', body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }
        });
        break;
      } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 3000)); }
    }
    if (!osm) throw lastErr;
    data = { place, osm };
    fs.writeFileSync(cacheFile, JSON.stringify(data));
    await new Promise(r => setTimeout(r, 1500)); // be polite between cases
  }
  const t0 = Date.now();
  // mirror app.js analyzeOpts: point-geocoded localities get a plausible-extent radius
  let opts = {};
  const p = data.place;
  if (p.osm_type !== 'relation') {
    const t = p.addresstype || p.type || '';
    const maxKm = /hamlet|isolated_dwelling/.test(t) ? 1.2 :
      /village|suburb|quarter|neighbourhood/.test(t) ? 2.0 : /town/.test(t) ? 3.5 : 5.0;
    opts = { center: [Number(p.lat), Number(p.lon)], maxKm };
  }
  const result = Promenade.analyze(data.osm.elements, opts);
  const ms = Date.now() - t0;

  console.log('\n=== ' + c.q + '  (expect: ' + c.expect + ' | truth: ' + c.truth + ')');
  console.log('  elements=' + data.osm.elements.length + ' status=' + result.status +
    ' maxCell=' + result.stats.maxCell + ' analyze=' + ms + 'ms');
  result.areas.forEach((a, i) => {
    console.log('  #' + (i + 1) + ' score=' + a.score + '  ' + a.label +
      (a.names.length > 2 ? ' (+ ' + a.names.slice(2).join(', ') + ')' : ''));
    const ev = a.evidence;
    console.log('      ped=' + ev.pedestrianMeters + 'm living=' + ev.livingStreetMeters +
      'm foot=' + ev.footpathMeters + 'm parkpath=' + ev.parkPathMeters + 'm food=' + ev.foodPlaces +
      ' squares=[' + ev.squares.join('; ') + '] water=' + ev.waterfront + ' kw=' + ev.promenadeName);
  });
  return { case: c, result };
}

(async () => {
  const filter = process.argv.slice(2);
  for (const c of CASES) {
    if (filter.length && !filter.some(f => c.q.toLowerCase().includes(f.toLowerCase()))) continue;
    try { await runCase(c); }
    catch (e) { console.error('FAILED ' + c.q + ': ' + e.message); }
  }
})();
