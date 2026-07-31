/* app.js — UI glue: geocoding, Overpass fetch with mirror fallback, map rendering. */
(function () {
  'use strict';

  var OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  var MAX_SPAN_DEG = 0.09; // clamp huge cities to ~10 km around the centre

  var RANK_COLORS = ['#e11d48', '#f59e0b', '#0ea5e9', '#8b5cf6', '#10b981'];

  var map, resultLayers = [];
  var $ = function (id) { return document.getElementById(id); };

  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([45.8, 24.15], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
  }

  function setStatus(msg, busy) {
    var el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('busy', !!busy);
  }

  function clearResults() {
    resultLayers.forEach(function (l) { map.removeLayer(l); });
    resultLayers = [];
    $('results').innerHTML = '';
    $('verdict').innerHTML = '';
    $('verdict').className = 'verdict';
  }

  // --- geocoding ---

  function geocode(query) {
    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' +
      encodeURIComponent(query);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('Geocoding failed (HTTP ' + r.status + ')');
        return r.json();
      })
      .then(function (list) {
        if (!list.length) throw new Error('Could not find “' + query + '”. Try adding the country, e.g. “Sibiu, Romania”.');
        // prefer administrative boundaries / places over POIs
        var pick = list.find(function (r) {
          return r.osm_type === 'relation' && r.category === 'boundary';
        }) || list.find(function (r) {
          return r.category === 'place' || r.category === 'boundary';
        }) || list[0];
        return pick;
      });
  }

  // --- Overpass ---

  function buildQuery(place) {
    var bb = place.boundingbox.map(Number); // [south, north, west, east]
    var s = bb[0], n = bb[1], w = bb[2], e = bb[3];
    var lat = Number(place.lat), lon = Number(place.lon);
    // clamp very large areas to the centre — promenades are (nearly) always central or waterfront
    var clamped = false;
    if (n - s > MAX_SPAN_DEG) { s = lat - MAX_SPAN_DEG / 2; n = lat + MAX_SPAN_DEG / 2; clamped = true; }
    if (e - w > MAX_SPAN_DEG * 1.4) { w = lon - MAX_SPAN_DEG * 0.7; e = lon + MAX_SPAN_DEG * 0.7; clamped = true; }
    var bbox = [s, w, n, e].join(',');

    var areaFilter = '';
    if (place.osm_type === 'relation') areaFilter = 'area(' + (3600000000 + place.osm_id) + ')->.a;';
    else if (place.osm_type === 'way') areaFilter = 'area(' + (2400000000 + place.osm_id) + ')->.a;';
    var inArea = areaFilter ? '(area.a)' : '';

    var q = '[out:json][timeout:90][bbox:' + bbox + '];\n' + areaFilter + '(\n' +
      '  way["highway"~"^(pedestrian|living_street)$"]' + inArea + ';\n' +
      '  way["highway"~"^(footway|path)$"]["name"]' + inArea + ';\n' +
      '  way["place"="square"]' + inArea + ';\n' +
      '  node["place"="square"]' + inArea + ';\n' +
      '  way["natural"="beach"]' + inArea + ';\n' +
      '  way["man_made"="pier"]' + inArea + ';\n' +
      '  way["leisure"~"^(marina|park|garden)$"]' + inArea + ';\n' +
      ');\nout tags geom;\n(\n' +
      '  node["amenity"~"^(cafe|restaurant|bar|pub|ice_cream|biergarten|fast_food)$"]' + inArea + ';\n' +
      '  way["amenity"~"^(cafe|restaurant|bar|pub|ice_cream|biergarten|fast_food)$"]' + inArea + ';\n' +
      '  node["amenity"="fountain"]' + inArea + ';\n' +
      '  node["leisure"="bandstand"]' + inArea + ';\n' +
      '  node["tourism"~"^(attraction|artwork|viewpoint)$"]' + inArea + ';\n' +
      ');\nout tags center;';
    return { query: q, clamped: clamped, analyzeOpts: analyzeOpts(place) };
  }

  // localities without an admin boundary get a plausible-extent radius
  function analyzeOpts(place) {
    if (place.osm_type === 'relation' || place.osm_type === 'way') return {};
    var t = (place.addresstype || place.type || '');
    var maxKm = /hamlet|isolated_dwelling/.test(t) ? 1.2 :
                /village|suburb|quarter|neighbourhood/.test(t) ? 2.0 :
                /town/.test(t) ? 3.5 : 5.0;
    return { center: [Number(place.lat), Number(place.lon)], maxKm: maxKm };
  }

  function fetchOverpass(query, mirrorIndex) {
    mirrorIndex = mirrorIndex || 0;
    // two passes over the mirror list — busy mirrors often recover within a minute
    if (mirrorIndex >= OVERPASS_MIRRORS.length * 2) {
      return Promise.reject(new Error('All Overpass servers are unavailable right now. Please try again in a minute.'));
    }
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 100000);
    return fetch(OVERPASS_MIRRORS[mirrorIndex % OVERPASS_MIRRORS.length], {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function (err) {
      clearTimeout(timer);
      console.warn('Overpass mirror failed:', OVERPASS_MIRRORS[mirrorIndex % OVERPASS_MIRRORS.length], err.message);
      var backoff = mirrorIndex + 1 >= OVERPASS_MIRRORS.length ? 5000 : 0;
      return new Promise(function (resolve) { setTimeout(resolve, backoff); })
        .then(function () { return fetchOverpass(query, mirrorIndex + 1); });
    });
  }

  // --- rendering ---

  function evidenceLine(ev) {
    var bits = [];
    var walkable = ev.pedestrianMeters + ev.livingStreetMeters;
    if (walkable > 0) bits.push(fmtMeters(walkable) + ' of pedestrian streets');
    if (ev.footpathMeters > 100) bits.push(fmtMeters(ev.footpathMeters) + ' of named walkways');
    if (ev.squares.length) bits.push(ev.squares.length === 1 ? 'public square (' + ev.squares[0] + ')' : ev.squares.length + ' public squares');
    if (ev.foodPlaces) bits.push(ev.foodPlaces + ' cafés/restaurants/bars');
    if (ev.pierMeters > 30) bits.push('pier');
    if (ev.beachMeters > 100) bits.push('beach frontage');
    if (ev.waterfront) bits.push('waterfront');
    if (ev.park) bits.push('adjoining park');
    if (ev.promenadeName) bits.push('named as a promenade');
    return bits.join(' · ');
  }

  function fmtMeters(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m';
  }

  function renderResults(result, place, clamped) {
    var verdict = $('verdict');
    var results = $('results');

    if (result.status === 'none') {
      verdict.className = 'verdict none';
      verdict.innerHTML = '<strong>No clear promenade found.</strong> ' +
        escapeHtml(shortName(place)) + ' doesn’t appear to have a distinct promenade area — no significant ' +
        'pedestrian streets, squares or waterfront walkways are mapped here. The local social spot may simply be ' +
        'the main road, a churchyard or a bus stop — or the area may be under-mapped in OpenStreetMap.';
      map.setView([Number(place.lat), Number(place.lon)], 15);
      return;
    }

    if (result.status === 'weak') {
      verdict.className = 'verdict weak';
      verdict.innerHTML = '<strong>No single dominant promenade,</strong> but there ' +
        (result.areas.length > 1 ? 'are some walkable spots' : 'is a modest walkable spot') +
        ' where people are likely to gather:';
    } else {
      verdict.className = 'verdict strong';
      verdict.innerHTML = '<strong>' +
        (result.areas.length > 1 ? 'Main promenade areas' : 'Main promenade area') +
        ' of ' + escapeHtml(shortName(place)) + ':</strong>';
    }
    if (clamped) {
      verdict.innerHTML += '<div class="note">Large city — searched the central ~10 km.</div>';
    }

    var allBounds = [];
    result.areas.forEach(function (area, i) {
      var color = RANK_COLORS[i % RANK_COLORS.length];

      var layers = [];
      if (area.hull.length >= 3) {
        layers.push(L.polygon(area.hull, {
          color: color, weight: 2, fillColor: color, fillOpacity: 0.10, dashArray: '6 4'
        }));
      }
      area.highlightWays.forEach(function (w) {
        if (w.kind === 'square' && w.coords.length > 3) {
          layers.push(L.polygon(w.coords, { color: color, weight: 3, fillColor: color, fillOpacity: 0.25 }));
        } else {
          layers.push(L.polyline(w.coords, { color: color, weight: 5, opacity: 0.85 }));
        }
      });
      var group = L.featureGroup(layers).addTo(map);
      group.bindPopup('<b>#' + (i + 1) + ' ' + escapeHtml(area.label) + '</b><br>' + escapeHtml(evidenceLine(area.evidence)));
      resultLayers.push(group);
      allBounds.push(group.getBounds());

      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="card-head"><span class="rank" style="background:' + color + '">' + (i + 1) + '</span>' +
        '<span class="card-title">' + escapeHtml(area.label) + '</span></div>' +
        (area.names.length > 2 ? '<div class="card-names">also: ' + escapeHtml(area.names.slice(2).join(', ')) + '</div>' : '') +
        '<div class="card-evidence">' + escapeHtml(evidenceLine(area.evidence)) + '</div>';
      card.addEventListener('click', function () {
        map.fitBounds(group.getBounds().pad(0.3));
        group.openPopup();
      });
      results.appendChild(card);
    });

    if (allBounds.length) {
      var b = allBounds[0];
      allBounds.slice(1).forEach(function (x) { b.extend(x); });
      map.fitBounds(b.pad(0.2));
    }
  }

  function shortName(place) {
    return place.display_name.split(',')[0];
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // --- search flow ---

  var searching = false;
  function search(query) {
    if (searching || !query.trim()) return;
    searching = true;
    $('go').disabled = true;
    clearResults();
    setStatus('Looking up “' + query + '”…', true);

    geocode(query)
      .then(function (place) {
        setStatus('Fetching walkable places from OpenStreetMap… (can take ~10–30 s)', true);
        var built = buildQuery(place);
        return fetchOverpass(built.query).then(function (data) {
          setStatus('Analyzing ' + data.elements.length + ' map features…', true);
          // let the status paint before the (synchronous) analysis
          return new Promise(function (resolve) {
            setTimeout(function () {
              resolve({ place: place, result: Promenade.analyze(data.elements, built.analyzeOpts), clamped: built.clamped });
            }, 30);
          });
        });
      })
      .then(function (r) {
        setStatus('');
        renderResults(r.result, r.place, r.clamped);
      })
      .catch(function (err) {
        setStatus('');
        var v = $('verdict');
        v.className = 'verdict error';
        v.textContent = err.message;
      })
      .finally(function () {
        searching = false;
        $('go').disabled = false;
      });
  }

  // --- boot ---

  document.addEventListener('DOMContentLoaded', function () {
    initMap();
    $('go').addEventListener('click', function () { search($('q').value); });
    $('q').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') search($('q').value);
    });
    document.querySelectorAll('.example').forEach(function (el) {
      el.addEventListener('click', function () {
        $('q').value = el.textContent;
        search(el.textContent);
      });
    });
  });
})();
