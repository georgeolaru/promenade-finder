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

  var map, resultLayers = [], historyLayer;
  var $ = function (id) { return document.getElementById(id); };

  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([45.8, 24.15], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    historyLayer = L.layerGroup().addTo(map);
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
        m.on('click', function () { showFromHistory(entry); });
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
      var gmaps = 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lon;
      var amaps = 'https://maps.apple.com/?daddr=' + lat + ',' + lon;

      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="card-head"><span class="rank" style="background:' + color + '">' + (i + 1) + '</span>' +
        '<span class="card-title">' + escapeHtml(area.label) + '</span></div>' +
        (kidFriendly ? '<div class="card-kids">🛝 Kid-friendly — ' + kidBits.join(', ') + '</div>' : '') +
        (area.names.length > 2 ? '<div class="card-names">also: ' + escapeHtml(area.names.slice(2).join(', ')) + '</div>' : '') +
        '<div class="card-evidence">' + escapeHtml(evidenceLine(area.evidence)) + '</div>' +
        '<div class="card-actions">' +
          '<a href="' + gmaps + '" target="_blank" rel="noopener">Google&nbsp;Maps&nbsp;→</a>' +
          '<a href="' + amaps + '" target="_blank" rel="noopener">Apple&nbsp;Maps&nbsp;→</a>' +
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

  function search(query) {
    if (searching || !query.trim()) return;
    var stops = query.split(';').map(function (s) { return s.trim(); }).filter(Boolean);
    if (stops.length > 1) return searchTrip(stops);
    searching = true;
    $('go').disabled = true;
    clearResults();
    rememberInUrl(query.trim());

    var agentPromise = AGENT_ENDPOINTS.length ? fetchSuggestions(query) : Promise.resolve(null);

    runPipeline(query.trim(), '')
      .then(function (r) {
        setStatus('');
        var rendered = renderResults(r.result, r.place, r.clamped) || [];
        saveHistoryEntry(query.trim(), r.place, r.result, r.clamped);
        if (rendered.length) {
          agentPromise.then(function (sugs) { annotateWithSuggestions(sugs, rendered); });
        }
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

  // trip mode: “Sibiu; Brașov; Sighișoara” — top spots of every stop on one map
  function searchTrip(stops) {
    if (searching) return;
    searching = true;
    $('go').disabled = true;
    clearResults();
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
            rendered.forEach(function (x) { allGroups.push(x.group); });
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
      $('go').disabled = false;
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
