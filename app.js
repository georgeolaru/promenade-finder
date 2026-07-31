/* app.js — UI glue: geocoding, Overpass fetch with mirror fallback, map rendering. */
(function () {
  'use strict';

  var OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];
  var MAX_SPAN_DEG = 0.09; // clamp huge cities to ~10 km around the centre

  var RANK_COLORS = ['#e11d48', '#f59e0b', '#0ea5e9', '#8b5cf6', '#10b981'];

  // Optional local-knowledge agent (Mac mini, claude CLI). Advisory only — the app
  // works fully without it. Same-host works when the app is served from the mini;
  // the Tailscale IP works for file:// and devices on the tailnet.
  var AGENT_ENDPOINTS = (function () {
    var eps = [];
    if (location.protocol !== 'https:') {
      if (location.hostname && location.hostname !== 'localhost') {
        eps.push('http://' + location.hostname + ':3041');
      }
      eps.push('http://localhost:3041', 'http://100.120.152.48:3041');
    }
    return eps.filter(function (v, i, a) { return a.indexOf(v) === i; });
  })();

  var map, resultLayers = [], historyLayer, gemsLayer;
  var $ = function (id) { return document.getElementById(id); };

  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([45.8, 24.15], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    historyLayer = L.layerGroup().addTo(map);
    gemsLayer = L.layerGroup().addTo(map);
    map.on('click', onMapClick);
  }

  // --- owner-run food & coffee (experimental) ---
  // Live research needs the mini agent; already-researched localities are also
  // published as static JSON under gems/ so the https site can show them anywhere.

  function gemsSlug(q) {
    return q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  }

  function fetchStaticGems(placeQuery) {
    var slug = gemsSlug(placeQuery);
    var candidates = [slug, slug + '-romania'];
    var i = 0;
    function tryNext() {
      if (i >= candidates.length) {
        return Promise.reject(new Error('Not researched yet for this locality — run it from the Mac mini version.'));
      }
      return fetch('gems/' + candidates[i++] + '.json')
        .then(function (r) { if (!r.ok) throw new Error('miss'); return r.json(); })
        .then(function (d) {
          if (!d || !Array.isArray(d.places)) throw new Error('miss');
          return d.places;
        })
        .catch(tryNext);
    }
    return tryNext();
  }

  function loadResearchedIndex() {
    fetch('gems/index.json')
      .then(function (r) { if (!r.ok) throw new Error('none'); return r.json(); })
      .then(function (d) {
        if (!d || !Array.isArray(d.localities) || !d.localities.length) return;
        var box = $('researched');
        box.innerHTML = '<span class="history-title">☕ Researched:</span>';
        d.localities.forEach(function (loc) {
          var chip = document.createElement('span');
          chip.className = 'researched-chip';
          chip.textContent = loc.label + ' (' + loc.count + ')';
          chip.addEventListener('click', function () { showResearched(loc); });
          box.appendChild(chip);
          var m = L.circleMarker([loc.lat, loc.lon], {
            radius: 5, color: '#b45309', weight: 1.5, fillColor: '#f59e0b', fillOpacity: 0.6
          });
          m.bindTooltip('☕ ' + loc.label + ' — ' + loc.count + ' owner-run places');
          m.on('click', function () { lastLayerClick = Date.now(); showResearched(loc); });
          historyLayer.addLayer(m);
        });
      })
      .catch(function () { /* no static dataset published */ });
  }

  function showResearched(loc) {
    fetchStaticGems(loc.slug)
      .then(function (places) {
        map.setView([loc.lat, loc.lon], 13);
        renderGems(places, { display_name: loc.label });
      })
      .catch(function (err) { setStatus('☕ ' + err.message); });
  }

  function fetchGems(placeQuery, endpointIndex) {
    endpointIndex = endpointIndex || 0;
    if (endpointIndex >= AGENT_ENDPOINTS.length) {
      return fetchStaticGems(placeQuery); // published dataset fallback (https site)
    }
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 420000);
    return fetch(AGENT_ENDPOINTS[endpointIndex] + '/gems?place=' + encodeURIComponent(placeQuery),
      { signal: controller.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!d || !Array.isArray(d.places)) throw new Error('bad agent response');
        return d.places;
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (endpointIndex + 1 < AGENT_ENDPOINTS.length) return fetchGems(placeQuery, endpointIndex + 1);
        throw err;
      });
  }

  function gemsFromHeader() {
    var q = ($('q').value || '').split(';')[0].trim();
    if (!q) {
      setStatus('Type a locality first, then hit ☕ Owner-run.');
      return;
    }
    var btn = $('gems');
    btn.disabled = true;
    btn.textContent = '☕ Researching… (first time ≈5 min)';
    fetchGems(q)
      .then(function (places) { renderGems(places, { display_name: q }); })
      .catch(function (err) { setStatus('☕ ' + err.message); })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = '☕ Owner-run';
      });
  }

  function renderGems(places, place) {
    var old = document.getElementById('gems-section');
    if (old) old.remove();
    gemsLayer.clearLayers();

    var results = $('results');
    var section = document.createElement('div');
    section.id = 'gems-section';
    var head = document.createElement('div');
    head.className = 'trip-head';
    head.textContent = '☕ Owner-run food & coffee in ' + shortName(place) +
      ' — researched by the local agent (experimental)';
    section.appendChild(head);
    results.insertBefore(section, results.firstChild);
    if (!places.length) {
      var none = document.createElement('div');
      none.className = 'agent-note';
      none.textContent = 'The agent could not confirm any owner-run places here.';
      section.appendChild(none);
      return;
    }
    var cityForLinks = shortName(place);
    places.forEach(function (p) {
      var gq = encodeURIComponent(p.name + ', ' + cityForLinks);
      var gmaps = 'https://www.google.com/maps/search/?api=1&query=' + gq;
      var amaps = 'https://maps.apple.com/?q=' + gq;
      var card = document.createElement('div');
      card.className = 'card gem';
      card.innerHTML =
        '<div class="card-head"><span class="gem-dot conf-' + (p.confidence || 'low') + '"></span>' +
        '<span class="card-title">' + escapeHtml(p.name) + '</span>' +
        '<span class="gem-type">' + escapeHtml(p.type || '') + '</span></div>' +
        (p.area ? '<div class="card-names">' + escapeHtml(p.area) + '</div>' : '') +
        '<div class="card-evidence">' + escapeHtml(p.evidence || '') + '</div>' +
        '<div class="card-actions">' +
          '<a href="' + gmaps + '" target="_blank" rel="noopener">Google&nbsp;Maps&nbsp;→</a>' +
          '<a class="secondary" href="' + amaps + '" target="_blank" rel="noopener">Apple&nbsp;Maps</a>' +
        '</div>';
      section.appendChild(card);
    });
    // geocode pins politely (Nominatim: 1 req/s)
    var cityName = shortName(place);
    var i = 0;
    (function next() {
      if (i >= places.length) return;
      var p = places[i++];
      fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' +
        encodeURIComponent(p.name + ', ' + cityName))
        .then(function (r) { return r.json(); })
        .then(function (list) {
          if (list.length) {
            var m = L.circleMarker([Number(list[0].lat), Number(list[0].lon)], {
              radius: 8, color: '#f59e0b', weight: 2, fillColor: '#fbbf24', fillOpacity: 0.85
            });
            m.bindTooltip('☕ ' + p.name);
            m.bindPopup('<b>' + escapeHtml(p.name) + '</b><br>' + escapeHtml(p.evidence || '') +
              '<br><a href="https://www.google.com/maps/search/?api=1&query=' +
              encodeURIComponent(p.name + ', ' + cityName) +
              '" target="_blank" rel="noopener">Google Maps →</a>');
            m.on('click', function () { lastLayerClick = Date.now(); });
            gemsLayer.addLayer(m);
          }
        })
        .catch(function () { /* skip pin */ })
        .finally(function () { setTimeout(next, 1100); });
    })();
  }

  // --- click anywhere on the map to Find that locality ---

  var lastLayerClick = 0; // suppress map-click when a marker/area was clicked

  function onMapClick(e) {
    if (Date.now() - lastLayerClick < 500) return;
    var lat = e.latlng.lat, lon = e.latlng.lng;
    var popup = L.popup({ maxWidth: 240 })
      .setLatLng(e.latlng)
      .setContent('<div class="find-here-box">Looking up locality…</div>')
      .openOn(map);
    fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=13&lat=' + lat + '&lon=' + lon)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var a = d.address || {};
        var locality = a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb;
        if (!locality) {
          popup.setContent('<div class="find-here-box">No locality here.</div>');
          return;
        }
        var q = locality + (a.county ? ', ' + a.county : '') + (a.country ? ', ' + a.country : '');
        var el = document.createElement('div');
        el.className = 'find-here-box';
        el.innerHTML = '<b>' + escapeHtml(locality) + '</b><br>';
        var btn = document.createElement('button');
        btn.className = 'find-here-btn';
        btn.textContent = '🔍 Find promenades';
        btn.addEventListener('click', function () {
          map.closePopup();
          $('q').value = q;
          search(q);
        });
        el.appendChild(btn);
        popup.setContent(el);
      })
      .catch(function () {
        popup.setContent('<div class="find-here-box">Could not identify this place.</div>');
      });
  }

  // --- history of processed places (localStorage, always visible on the map) ---

  var HKEY = 'pf_history_v1';

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HKEY)) || []; }
    catch (e) { return []; }
  }

  function saveHistoryEntry(query, place, result, clamped) {
    var entry = {
      q: query,
      ts: Date.now(),
      clamped: !!clamped,
      place: {
        display_name: place.display_name,
        lat: place.lat, lon: place.lon
      },
      result: { status: result.status, areas: result.areas }
    };
    var hist = loadHistory().filter(function (h) {
      return h.q.toLowerCase() !== query.toLowerCase();
    });
    hist.unshift(entry);
    hist = hist.slice(0, 30);
    for (;;) {
      try { localStorage.setItem(HKEY, JSON.stringify(hist)); break; }
      catch (e) {
        if (hist.length <= 1) break; // one entry too big for quota — give up quietly
        hist.pop();
      }
    }
    renderHistory();
  }

  function showFromHistory(entry) {
    if (searching) return;
    clearResults();
    $('q').value = entry.q;
    rememberInUrl(entry.q);
    var rendered = renderResults(entry.result, entry.place, entry.clamped) || [];
    var when = new Date(entry.ts);
    var note = document.createElement('div');
    note.className = 'note';
    note.innerHTML = 'From history (' + when.toLocaleDateString() + ') · ' +
      '<a href="#" id="refresh-history">refresh now</a>';
    $('verdict').appendChild(note);
    var link = document.getElementById('refresh-history');
    if (link) {
      link.addEventListener('click', function (e) { e.preventDefault(); search(entry.q); });
    }
    return rendered;
  }

  function renderHistory() {
    var hist = loadHistory();
    if (historyLayer) {
      historyLayer.clearLayers();
      hist.forEach(function (entry) {
        var m = L.circleMarker([Number(entry.place.lat), Number(entry.place.lon)], {
          radius: 7, color: '#14b8a6', weight: 2, fillColor: '#14b8a6', fillOpacity: 0.5
        });
        var label = shortName(entry.place) +
          (entry.result.status === 'none' ? ' (no promenade)' : '');
        m.bindTooltip(label);
        m.on('click', function () { lastLayerClick = Date.now(); showFromHistory(entry); });
        historyLayer.addLayer(m);
      });
    }
    var box = $('history');
    if (box) {
      box.innerHTML = hist.length ? '<span class="history-title">Visited:</span>' : '';
      hist.slice(0, 10).forEach(function (entry) {
        var chip = document.createElement('span');
        chip.className = 'history-chip' + (entry.result.status === 'none' ? ' none' : '');
        chip.textContent = shortName(entry.place);
        chip.title = entry.q;
        chip.addEventListener('click', function () { showFromHistory(entry); });
        box.appendChild(chip);
      });
    }
  }

  function setStatus(msg, busy) {
    var el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('busy', !!busy);
  }

  function clearResults() {
    resultLayers.forEach(function (l) { map.removeLayer(l); });
    resultLayers = [];
    if (gemsLayer) gemsLayer.clearLayers();
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
        // prefer the locality itself — never a county/region that shares its name
        var LOCALITY = /^(city|town|village|municipality|hamlet|borough|suburb|quarter|neighbourhood)$/;
        var REGION = /^(county|state|region|province|district)$/;
        var pick = list.find(function (r) {
          return LOCALITY.test(r.addresstype || '') && r.osm_type === 'relation';
        }) || list.find(function (r) {
          return LOCALITY.test(r.addresstype || '');
        }) || list.find(function (r) {
          return r.osm_type === 'relation' && r.category === 'boundary' && !REGION.test(r.addresstype || '');
        }) || list.find(function (r) {
          return (r.category === 'place' || r.category === 'boundary') && !REGION.test(r.addresstype || '');
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

    // area filter only for relations — Overpass often has no area object for a
    // locality mapped as a closed way (e.g. Vaslui city), which would silently
    // return zero results; the tight city bbox + radius filter covers those.
    var areaFilter = '';
    if (place.osm_type === 'relation') areaFilter = 'area(' + (3600000000 + place.osm_id) + ')->.a;';
    var inArea = areaFilter ? '(area.a)' : '';

    var q = '[out:json][timeout:90][bbox:' + bbox + '];\n' + areaFilter + '(\n' +
      '  way["highway"~"^(pedestrian|living_street)$"]' + inArea + ';\n' +
      '  way["highway"~"^(footway|path)$"]["name"]' + inArea + ';\n' +
      '  way["place"="square"]' + inArea + ';\n' +
      '  node["place"="square"]' + inArea + ';\n' +
      '  way["natural"="beach"]' + inArea + ';\n' +
      '  way["man_made"="pier"]' + inArea + ';\n' +
      '  way["leisure"~"^(marina|park|garden|water_park|beach_resort|swimming_area|recreation_ground)$"]' + inArea + ';\n' +
      '  way["landuse"="recreation_ground"]' + inArea + ';\n' +
      ');\nout tags geom;\n' +
      // unnamed alleys inside parks & leisure areas — where strolling actually happens
      'way["leisure"~"^(park|garden|water_park|beach_resort|recreation_ground)$"]' + inArea + ';\n' +
      'map_to_area ->.parkareas;\n' +
      'way["highway"~"^(footway|path)$"](area.parkareas);\n' +
      'out tags geom;\n(\n' +
      '  node["amenity"~"^(cafe|restaurant|bar|pub|ice_cream|biergarten|fast_food)$"]' + inArea + ';\n' +
      '  way["amenity"~"^(cafe|restaurant|bar|pub|ice_cream|biergarten|fast_food)$"]' + inArea + ';\n' +
      '  node["amenity"="fountain"]' + inArea + ';\n' +
      '  node["leisure"="bandstand"]' + inArea + ';\n' +
      '  node["leisure"="playground"]' + inArea + ';\n' +
      '  way["leisure"="playground"]' + inArea + ';\n' +
      '  node["amenity"~"^(bench|drinking_water)$"]' + inArea + ';\n' +
      '  node["tourism"~"^(attraction|artwork|viewpoint)$"]' + inArea + ';\n' +
      ');\nout tags center;';
    return { query: q, clamped: clamped, analyzeOpts: analyzeOpts(place) };
  }

  // localities without a usable admin-boundary area get a plausible-extent radius
  function analyzeOpts(place) {
    if (place.osm_type === 'relation') return {};
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
    if (ev.parkPathMeters > 150) bits.push(fmtMeters(ev.parkPathMeters) + ' of park alleys');
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

  function renderResults(result, place, clamped, opts) {
    opts = opts || {};
    var verdict = $('verdict');
    var results = $('results');

    if (opts.trip) {
      var head = document.createElement('div');
      head.className = 'trip-head';
      head.textContent = shortName(place) +
        (result.status === 'none' ? ' — no clear promenade' :
         result.status === 'weak' ? ' — modest walkable spots' : '');
      results.appendChild(head);
    }

    if (result.status === 'none') {
      if (!opts.trip) {
        verdict.className = 'verdict none';
        verdict.innerHTML = '<strong>No clear promenade found.</strong> ' +
          escapeHtml(shortName(place)) + ' doesn’t appear to have a distinct promenade area — no significant ' +
          'pedestrian streets, squares or waterfront walkways are mapped here. The local social spot may simply be ' +
          'the main road, a churchyard or a bus stop — or the area may be under-mapped in OpenStreetMap.';
        map.setView([Number(place.lat), Number(place.lon)], 15);
      }
      return [];
    }

    if (!opts.trip) {
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
    }

    var shownAreas = opts.limit ? result.areas.slice(0, opts.limit) : result.areas;
    var colorOffset = opts.colorOffset || 0;
    var allBounds = [];
    var rendered = [];
    shownAreas.forEach(function (area, i) {
      var color = RANK_COLORS[(i + colorOffset) % RANK_COLORS.length];

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
      group.on('click', function () { lastLayerClick = Date.now(); });
      group.bindPopup('<b>#' + (i + 1) + ' ' + escapeHtml(area.label) + '</b><br>' + escapeHtml(evidenceLine(area.evidence)));
      resultLayers.push(group);
      allBounds.push(group.getBounds());

      // kid-friendly: traffic-free walking plus playgrounds, or a furnished
      // promenade (benches, fountains) where kids can roam safely
      var ev = area.evidence;
      var trafficFree = ev.pedestrianMeters + ev.parkPathMeters + ev.footpathMeters;
      var kidFriendly = trafficFree >= 300 &&
        (ev.playgrounds >= 1 || ev.furniture >= 5 || (ev.park && trafficFree >= 500));
      var kidBits = [];
      if (ev.playgrounds >= 1) kidBits.push(ev.playgrounds === 1 ? '1 playground' : ev.playgrounds + ' playgrounds');
      if (ev.furniture >= 5) kidBits.push(ev.furniture + ' benches');
      kidBits.push('car-free walking');

      var lat = area.center[0].toFixed(6), lon = area.center[1].toFixed(6);
      // primary links open the location pin; directions are secondary
      var gmapsLoc = 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lon;
      var amapsLoc = 'https://maps.apple.com/?ll=' + lat + ',' + lon +
        '&q=' + encodeURIComponent(area.label);
      var gmapsDir = 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lon;

      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="card-head"><span class="rank" style="background:' + color + '">' + (i + 1) + '</span>' +
        '<span class="card-title">' + escapeHtml(area.label) + '</span></div>' +
        (kidFriendly ? '<div class="card-kids">🛝 Kid-friendly — ' + kidBits.join(', ') + '</div>' : '') +
        (area.names.length > 2 ? '<div class="card-names">also: ' + escapeHtml(area.names.slice(2).join(', ')) + '</div>' : '') +
        '<div class="card-evidence">' + escapeHtml(evidenceLine(area.evidence)) + '</div>' +
        '<div class="card-actions">' +
          '<a href="' + gmapsLoc + '" target="_blank" rel="noopener">Google&nbsp;Maps&nbsp;→</a>' +
          '<a href="' + amapsLoc + '" target="_blank" rel="noopener">Apple&nbsp;Maps&nbsp;→</a>' +
          '<a class="secondary" href="' + gmapsDir + '" target="_blank" rel="noopener">directions</a>' +
        '</div>';
      card.addEventListener('click', function (e) {
        if (e.target.closest('a')) return; // let directions links navigate
        map.fitBounds(group.getBounds().pad(0.3));
        group.openPopup();
      });
      results.appendChild(card);
      rendered.push({ area: area, card: card, group: group });
    });

    if (allBounds.length && !opts.noFit) {
      var b = allBounds[0];
      allBounds.slice(1).forEach(function (x) { b.extend(x); });
      map.fitBounds(b.pad(0.2));
    }
    return rendered;
  }

  function shortName(place) {
    return place.display_name.split(',')[0];
  }

  // --- local-knowledge agent (advisory) ---

  function fetchSuggestions(placeQuery, endpointIndex) {
    endpointIndex = endpointIndex || 0;
    if (endpointIndex >= AGENT_ENDPOINTS.length) return Promise.resolve(null);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 180000);
    return fetch(AGENT_ENDPOINTS[endpointIndex] + '/suggest?place=' + encodeURIComponent(placeQuery),
      { signal: controller.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) { return d && Array.isArray(d.areas) ? d.areas : null; })
      .catch(function () {
        clearTimeout(timer);
        return fetchSuggestions(placeQuery, endpointIndex + 1);
      });
  }

  function normTokens(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
      .filter(function (t) {
        return t.length > 3 &&
          ['parcul', 'parc', 'park', 'strada', 'street', 'piata', 'square', 'aleea',
           'bulevardul', 'boulevard', 'central', 'zona', 'area', 'promenade', 'promenada'].indexOf(t) === -1;
      });
  }

  function annotateWithSuggestions(suggestions, renderedAreas) {
    if (!suggestions || !suggestions.length) return;
    var unmatched = [];
    suggestions.forEach(function (sug) {
      var sugTokens = normTokens(sug.name);
      var hit = null;
      renderedAreas.forEach(function (ra) {
        if (hit) return;
        var areaTokens = [];
        ra.area.names.forEach(function (n) { areaTokens = areaTokens.concat(normTokens(n)); });
        areaTokens = areaTokens.concat(normTokens(ra.area.label));
        var overlap = sugTokens.some(function (t) { return areaTokens.indexOf(t) !== -1; });
        if (overlap) hit = ra;
      });
      if (hit) {
        if (!hit.card.querySelector('.card-local')) {
          var div = document.createElement('div');
          div.className = 'card-local';
          div.textContent = '⭐ Local knowledge agrees: ' + (sug.why || sug.name);
          hit.card.appendChild(div);
        }
      } else if (sug.confidence === 'high') {
        unmatched.push(sug.name);
      }
    });
    if (unmatched.length) {
      var note = document.createElement('div');
      note.className = 'agent-note';
      note.textContent = 'Local knowledge also mentions: ' + unmatched.join(', ') +
        ' (not confirmed by map data).';
      $('results').appendChild(note);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // --- search flow ---

  var searching = false;

  // geocode → Overpass → analyze, for one locality
  function runPipeline(query, statusPrefix) {
    setStatus(statusPrefix + 'Looking up “' + query + '”…', true);
    return geocode(query).then(function (place) {
      setStatus(statusPrefix + 'Fetching walkable places from OpenStreetMap… (can take ~10–30 s)', true);
      var built = buildQuery(place);
      return fetchOverpass(built.query).then(function (data) {
        setStatus(statusPrefix + 'Analyzing ' + data.elements.length + ' map features…', true);
        // let the status paint before the (synchronous) analysis
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve({ place: place, result: Promenade.analyze(data.elements, built.analyzeOpts), clamped: built.clamped });
          }, 30);
        });
      });
    });
  }

  function rememberInUrl(query) {
    try { history.replaceState(null, '', '?q=' + encodeURIComponent(query)); } catch (e) { /* file:// */ }
  }

  // queue: Find while a search runs enqueues it; results accumulate on the board
  var queue = [];
  var board = { groups: [], queries: [], labels: [] };

  function updateQueueUI() {
    var el = $('queue');
    if (el) el.textContent = queue.length ? '⏳ Queued: ' + queue.join(' · ') : '';
  }

  function drainQueue() {
    if (!queue.length) return;
    var next = queue.shift();
    updateQueueUI();
    var stops = next.split(';').map(function (s) { return s.trim(); }).filter(Boolean);
    if (stops.length > 1) searchTrip(stops);
    else runSingle(next, true);
  }

  function search(query) {
    query = (query || '').trim();
    if (!query) return;
    if (searching) {
      if (queue.length < 8 && queue.indexOf(query) === -1) {
        queue.push(query);
        updateQueueUI();
      }
      return;
    }
    var stops = query.split(';').map(function (s) { return s.trim(); }).filter(Boolean);
    if (stops.length > 1) return searchTrip(stops);
    runSingle(query, false);
  }

  function fitBoard() {
    if (!board.groups.length) return;
    var b = board.groups[0].getBounds();
    board.groups.slice(1).forEach(function (g) { b.extend(g.getBounds()); });
    map.fitBounds(b.pad(0.15));
  }

  function runSingle(query, append) {
    searching = true;
    if (!append) {
      clearResults();
      board = { groups: [], queries: [], labels: [] };
    }

    var agentPromise = (!append && AGENT_ENDPOINTS.length) ? fetchSuggestions(query) : Promise.resolve(null);

    runPipeline(query, append ? '[' + query + '] ' : '')
      .then(function (r) {
        setStatus('');
        var rendered = renderResults(r.result, r.place, r.clamped,
          append ? { trip: true, limit: 3, noFit: true, colorOffset: board.labels.length } : {}) || [];
        saveHistoryEntry(query, r.place, r.result, r.clamped);
        board.queries.push(query);
        board.labels.push(shortName(r.place));
        rendered.forEach(function (x) { board.groups.push(x.group); });
        rememberInUrl(board.queries.join('; '));
        if (append) {
          var v = $('verdict');
          v.className = 'verdict strong';
          v.innerHTML = '<strong>Trip: ' + escapeHtml(board.labels.join(' → ')) + '</strong>';
          fitBoard();
        } else if (rendered.length) {
          agentPromise.then(function (sugs) { annotateWithSuggestions(sugs, rendered); });
        }
      })
      .catch(function (err) {
        setStatus('');
        if (append) {
          var head = document.createElement('div');
          head.className = 'trip-head';
          head.textContent = query + ' — ' + err.message;
          $('results').appendChild(head);
        } else {
          var v2 = $('verdict');
          v2.className = 'verdict error';
          v2.textContent = err.message;
        }
      })
      .finally(function () {
        searching = false;
        drainQueue();
      });
  }

  // trip mode: “Sibiu; Brașov; Sighișoara” — top spots of every stop on one map
  function searchTrip(stops) {
    if (searching) return;
    searching = true;
    clearResults();
    board = { groups: [], queries: [], labels: [] };
    stops = stops.slice(0, 6);
    rememberInUrl(stops.join('; '));
    var verdict = $('verdict');
    verdict.className = 'verdict strong';
    verdict.innerHTML = '<strong>Trip: ' + escapeHtml(stops.join(' → ')) + '</strong>';

    var allGroups = [];
    var chain = Promise.resolve();
    stops.forEach(function (stop, idx) {
      chain = chain.then(function () {
        var prefix = '[' + (idx + 1) + '/' + stops.length + '] ';
        return runPipeline(stop, prefix)
          .then(function (r) {
            var rendered = renderResults(r.result, r.place, r.clamped,
              { trip: true, limit: 2, noFit: true, colorOffset: idx }) || [];
            saveHistoryEntry(stop, r.place, r.result, r.clamped);
            board.queries.push(stop);
            board.labels.push(shortName(r.place));
            rendered.forEach(function (x) { allGroups.push(x.group); board.groups.push(x.group); });
          })
          .catch(function (err) {
            var head = document.createElement('div');
            head.className = 'trip-head';
            head.textContent = stop + ' — ' + err.message;
            $('results').appendChild(head);
          });
      });
    });
    chain.finally(function () {
      setStatus('');
      if (allGroups.length) {
        var b = allGroups[0].getBounds();
        allGroups.slice(1).forEach(function (g) { b.extend(g.getBounds()); });
        map.fitBounds(b.pad(0.15));
      }
      searching = false;
      drainQueue();
    });
  }

  // near me: locate → reverse-geocode to the locality → search it
  function searchNearMe() {
    if (searching) return;
    if (!navigator.geolocation) {
      setStatus('Geolocation is not available in this browser.');
      return;
    }
    setStatus('Locating you…', true);
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=13&lat=' + lat + '&lon=' + lon)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var a = d.address || {};
          var locality = a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb;
          if (!locality) throw new Error('Could not work out which locality you are in.');
          var q = locality + (a.county ? ', ' + a.county : '') + (a.country ? ', ' + a.country : '');
          $('q').value = q;
          search(q);
        })
        .catch(function (err) { setStatus(err.message || 'Reverse geocoding failed.'); });
    }, function (err) {
      setStatus(err.code === 1 ? 'Location permission denied.' :
        'Could not get your location (' + err.message + '). Note: location needs the https version.');
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  }

  // --- boot ---

  document.addEventListener('DOMContentLoaded', function () {
    initMap();
    renderHistory();
    $('go').addEventListener('click', function () { search($('q').value); });
    $('near').addEventListener('click', searchNearMe);
    $('gems').addEventListener('click', gemsFromHeader);
    loadResearchedIndex();
    $('q').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') search($('q').value);
    });
    document.querySelectorAll('.example').forEach(function (el) {
      el.addEventListener('click', function () {
        $('q').value = el.textContent;
        search(el.textContent);
      });
    });
    // shareable / bookmarkable searches: ?q=Sibiu or ?q=Sibiu;%20Brașov
    var q = new URLSearchParams(location.search).get('q');
    if (q) { $('q').value = q; search(q); }
  });
})();
