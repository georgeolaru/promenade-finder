/* app.js — map-explorer UI: the map is the stage, localities are a collection,
 * Walk / Eat & Drink are toggleable layers. Analysis engine lives in promenade.js. */
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
  var HKEY = 'pf_history_v1';

  // Optional local-knowledge agent (Mac mini). Advisory + live gems research.
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

  var map, explorerLayer;
  var loaded = [];   // [{key, query, label, place, result, clamped, walkGroup, eatGroup, el, gems}]
  var queue = [];
  var searching = false;
  var layersOn = { walk: true, eat: true };
  var researchedIndex = []; // from gems/index.json

  var $ = function (id) { return document.getElementById(id); };
  var isMobile = function () { return window.matchMedia('(max-width: 760px)').matches; };
  var isTouch = window.matchMedia('(pointer: coarse)').matches;
  function openSheet() { if (isMobile()) document.body.classList.add('sheet-open'); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtMeters(m) { return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m'; }
  function shortName(place) { return String(place.display_name || '').split(',')[0]; }
  function slugOf(q) {
    return String(q).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  }

  // ---------- map ----------

  var lastLayerClick = 0;

  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([45.9, 25.0], 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    explorerLayer = L.layerGroup().addTo(map);
    // touch: plain taps must stay free for panning/pins — locality lookup goes on
    // long-press (Leaflet fires 'contextmenu' for it); desktop keeps plain click
    if (isTouch) {
      map.on('contextmenu', function (e) {
        if (e.originalEvent) e.originalEvent.preventDefault();
        onMapClick(e);
      });
    } else {
      map.on('click', onMapClick);
    }
  }

  function onMapClick(e) {
    if (Date.now() - lastLayerClick < 500) return;
    var lat = e.latlng.lat, lon = e.latlng.lng;
    var popup = L.popup({ maxWidth: 240 }).setLatLng(e.latlng)
      .setContent('<div class="find-here-box">Looking up locality…</div>').openOn(map);
    fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=13&lat=' + lat + '&lon=' + lon)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var a = d.address || {};
        var locality = a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb;
        if (!locality) { popup.setContent('<div class="find-here-box">No locality here.</div>'); return; }
        var q = locality + (a.county ? ', ' + a.county : '') + (a.country ? ', ' + a.country : '');
        var el = document.createElement('div');
        el.className = 'find-here-box';
        el.innerHTML = '<b>' + escapeHtml(locality) + '</b><br>';
        var btn = document.createElement('button');
        btn.className = 'find-here-btn';
        btn.textContent = '＋ Add to map';
        btn.addEventListener('click', function () { map.closePopup(); addLocality(q); });
        el.appendChild(btn);
        popup.setContent(el);
      })
      .catch(function () { popup.setContent('<div class="find-here-box">Could not identify this place.</div>'); });
  }

  // ---------- status / queue ----------

  function setStatus(msg, busy) {
    var el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('busy', !!busy);
  }
  function updateQueueUI() {
    $('queue').textContent = queue.length ? '⏳ Queued: ' + queue.map(function (q) { return q.split(',')[0]; }).join(' · ') : '';
  }

  // ---------- history (visited) ----------

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch (e) { return []; }
  }
  function saveHistoryEntry(query, place, result, clamped) {
    var entry = {
      q: query, ts: Date.now(), clamped: !!clamped,
      place: { display_name: place.display_name, lat: place.lat, lon: place.lon },
      result: { status: result.status, areas: result.areas }
    };
    var hist = loadHistory().filter(function (h) { return slugOf(h.q) !== slugOf(query); });
    hist.unshift(entry);
    hist = hist.slice(0, 30);
    for (;;) {
      try { localStorage.setItem(HKEY, JSON.stringify(hist)); break; }
      catch (e) { if (hist.length <= 1) break; hist.pop(); }
    }
    renderExplorer();
  }

  // ---------- geocoding & Overpass ----------

  function geocode(query) {
    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' + encodeURIComponent(query);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('Geocoding failed (HTTP ' + r.status + ')');
        return r.json();
      })
      .then(function (list) {
        if (!list.length) throw new Error('Could not find “' + query + '”. Try adding the country.');
        var LOCALITY = /^(city|town|village|municipality|hamlet|borough|suburb|quarter|neighbourhood)$/;
        var REGION = /^(county|state|region|province|district)$/;
        return list.find(function (r) { return LOCALITY.test(r.addresstype || '') && r.osm_type === 'relation'; })
          || list.find(function (r) { return LOCALITY.test(r.addresstype || ''); })
          || list.find(function (r) { return r.osm_type === 'relation' && r.category === 'boundary' && !REGION.test(r.addresstype || ''); })
          || list.find(function (r) { return (r.category === 'place' || r.category === 'boundary') && !REGION.test(r.addresstype || ''); })
          || list[0];
      });
  }

  function buildQuery(place) {
    var bb = place.boundingbox.map(Number); // [s, n, w, e]
    var s = bb[0], n = bb[1], w = bb[2], e = bb[3];
    var lat = Number(place.lat), lon = Number(place.lon);
    var clamped = false;
    if (n - s > MAX_SPAN_DEG) { s = lat - MAX_SPAN_DEG / 2; n = lat + MAX_SPAN_DEG / 2; clamped = true; }
    if (e - w > MAX_SPAN_DEG * 1.4) { w = lon - MAX_SPAN_DEG * 0.7; e = lon + MAX_SPAN_DEG * 0.7; clamped = true; }
    var bbox = [s, w, n, e].join(',');
    // area filter only for relations — ways often have no Overpass area object
    var areaFilter = place.osm_type === 'relation' ? 'area(' + (3600000000 + place.osm_id) + ')->.a;' : '';
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

  // ---------- local-knowledge agent (advisory badges) ----------

  function fetchSuggestions(placeQuery, endpointIndex) {
    endpointIndex = endpointIndex || 0;
    if (endpointIndex >= AGENT_ENDPOINTS.length) return Promise.resolve(null);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 180000);
    return fetch(AGENT_ENDPOINTS[endpointIndex] + '/suggest?place=' + encodeURIComponent(placeQuery),
      { signal: controller.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { return d && Array.isArray(d.areas) ? d.areas : null; })
      .catch(function () { clearTimeout(timer); return fetchSuggestions(placeQuery, endpointIndex + 1); });
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

  function annotateWithSuggestions(suggestions, loc) {
    if (!suggestions || !suggestions.length || !loc.el) return;
    var cards = loc.el.querySelectorAll('.walk-list .card');
    suggestions.forEach(function (sug) {
      var sugTokens = normTokens(sug.name);
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var areaTokens = normTokens(card.getAttribute('data-names') || '');
        var hit = sugTokens.some(function (t) { return areaTokens.indexOf(t) !== -1; });
        if (hit && !card.querySelector('.card-local')) {
          var div = document.createElement('div');
          div.className = 'card-local';
          div.textContent = '⭐ Local knowledge agrees: ' + (sug.why || sug.name);
          card.appendChild(div);
          break;
        }
      }
    });
  }

  // ---------- gems (owner-run places) ----------

  function fetchStaticGems(placeQuery) {
    var slug = slugOf(placeQuery);
    var candidates = [slug, slug + '-romania'];
    var i = 0;
    function tryNext() {
      if (i >= candidates.length) return Promise.reject(new Error('not researched'));
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

  function fetchLiveGems(placeQuery, endpointIndex) {
    endpointIndex = endpointIndex || 0;
    if (endpointIndex >= AGENT_ENDPOINTS.length) return Promise.reject(new Error('agent unreachable'));
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 420000);
    return fetch(AGENT_ENDPOINTS[endpointIndex] + '/gems?place=' + encodeURIComponent(placeQuery),
      { signal: controller.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (!d || !Array.isArray(d.places)) throw new Error('bad agent response');
        return d.places;
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (endpointIndex + 1 < AGENT_ENDPOINTS.length) return fetchLiveGems(placeQuery, endpointIndex + 1);
        throw err;
      });
  }

  // ---------- locality collection ----------

  function rememberInUrl() {
    try {
      var qs = loaded.length ? '?p=' + loaded.map(function (l) { return encodeURIComponent(l.query); }).join('|') : location.pathname;
      history.replaceState(null, '', loaded.length ? qs : location.pathname);
    } catch (e) { /* file:// */ }
  }

  function findLoaded(query) {
    var slug = slugOf(query);
    return loaded.find(function (l) { return l.key === slug || slugOf(l.label) === slug; });
  }

  function addLocality(query) {
    query = (query || '').trim();
    if (!query) return;
    // legacy multi-input: “A; B; C” just adds each
    var parts = query.split(';').map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length > 1) { parts.forEach(addLocality); return; }
    if (findLoaded(query)) { setStatus(query.split(',')[0] + ' is already on the map.'); return; }
    if (searching) {
      if (queue.length < 8 && queue.indexOf(query) === -1) { queue.push(query); updateQueueUI(); }
      return;
    }
    searching = true;
    $('empty-state').style.display = 'none';

    // instant path: cached visit
    var hist = loadHistory().find(function (h) { return slugOf(h.q) === slugOf(query); });
    var agentPromise = AGENT_ENDPOINTS.length ? fetchSuggestions(query) : Promise.resolve(null);

    var flow;
    if (hist) {
      flow = Promise.resolve({ place: hist.place, result: hist.result, clamped: hist.clamped, fromHistory: hist.ts });
    } else {
      setStatus('Looking up “' + query + '”…', true);
      flow = geocode(query).then(function (place) {
        setStatus('Fetching walkable places for ' + shortName(place) + '… (~10–30 s)', true);
        var built = buildQuery(place);
        return fetchOverpass(built.query).then(function (data) {
          setStatus('Analyzing ' + data.elements.length + ' map features…', true);
          return new Promise(function (resolve) {
            setTimeout(function () {
              resolve({ place: place, result: Promenade.analyze(data.elements, built.analyzeOpts), clamped: built.clamped });
            }, 30);
          });
        });
      });
    }

    flow.then(function (r) {
      setStatus('');
      if (!r.fromHistory) saveHistoryEntry(query, r.place, r.result, r.clamped);
      var loc = buildLocality(query, r);
      loaded.push(loc);
      renderLocalitySection(loc);
      renderExplorer();
      rememberInUrl();
      focusLocality(loc);
      openSheet();
      loadGemsFor(loc);
      agentPromise.then(function (sugs) { annotateWithSuggestions(sugs, loc); });
    }).catch(function (err) {
      setStatus(err.message);
    }).finally(function () {
      searching = false;
      if (queue.length) { var next = queue.shift(); updateQueueUI(); addLocality(next); }
    });
  }

  function buildLocality(query, r) {
    return {
      key: slugOf(query), query: query, label: shortName(r.place),
      place: r.place, result: r.result, clamped: r.clamped, fromHistory: r.fromHistory || null,
      walkGroup: L.layerGroup(), eatGroup: L.layerGroup(),
      gems: null, el: null
    };
  }

  function removeLocality(loc) {
    map.removeLayer(loc.walkGroup);
    map.removeLayer(loc.eatGroup);
    if (loc.el) loc.el.remove();
    loaded = loaded.filter(function (l) { return l !== loc; });
    renderExplorer();
    rememberInUrl();
    if (!loaded.length) $('empty-state').style.display = '';
  }

  function focusLocality(loc) {
    var b = null;
    loc.walkGroup.eachLayer(function (g) {
      var gb = g.getBounds ? g.getBounds() : L.latLngBounds([g.getLatLng()]);
      b = b ? b.extend(gb) : L.latLngBounds(gb.getSouthWest(), gb.getNorthEast());
    });
    if (b && b.isValid()) map.fitBounds(b.pad(0.2));
    else map.setView([Number(loc.place.lat), Number(loc.place.lon)], 14);
  }

  function fitAll() {
    var b = null;
    loaded.forEach(function (loc) {
      [loc.walkGroup, loc.eatGroup].forEach(function (grp) {
        grp.eachLayer(function (g) {
          var gb = g.getBounds ? g.getBounds() : L.latLngBounds([g.getLatLng()]);
          b = b ? b.extend(gb) : L.latLngBounds(gb.getSouthWest(), gb.getNorthEast());
        });
      });
    });
    if (b && b.isValid()) map.fitBounds(b.pad(0.15));
  }

  // ---------- rendering: locality section ----------

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

  function selectCard(card, group) {
    document.querySelectorAll('.card.selected').forEach(function (c) { c.classList.remove('selected'); });
    card.classList.add('selected');
    if (group) {
      var b = group.getBounds ? group.getBounds() : null;
      if (b && b.isValid && b.isValid()) map.fitBounds(b.pad(0.3));
      if (group.openPopup) group.openPopup();
    }
  }

  function flashCard(card) {
    document.querySelectorAll('.card.selected').forEach(function (c) { c.classList.remove('selected'); });
    card.classList.add('selected');
    openSheet();
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderLocalitySection(loc) {
    var sec = document.createElement('section');
    sec.className = 'locality';
    var statusWord = loc.result.status === 'none' ? 'no clear promenade' :
      loc.result.status === 'weak' ? 'modest walkable spots' : '';
    sec.innerHTML =
      '<header class="loc-head">' +
        '<button class="loc-toggle" title="Collapse">▾</button>' +
        '<span class="loc-name">' + escapeHtml(loc.label) + '</span>' +
        '<span class="loc-meta">' + escapeHtml(statusWord) + '</span>' +
        '<button class="loc-remove" title="Remove from map">✕</button>' +
      '</header>' +
      '<div class="loc-body">' +
        (loc.fromHistory ? '<div class="loc-note">From your history (' + new Date(loc.fromHistory).toLocaleDateString() + ') · <a href="#" class="loc-refresh">refresh</a></div>' : '') +
        (loc.clamped ? '<div class="loc-note">Wide boundary — searched ~10 km around the centre.</div>' : '') +
        '<div class="walk-list"></div>' +
        '<div class="eat-list"></div>' +
      '</div>';
    $('localities').appendChild(sec);
    loc.el = sec;

    sec.querySelector('.loc-remove').addEventListener('click', function () { removeLocality(loc); });
    sec.querySelector('.loc-toggle').addEventListener('click', function () {
      sec.classList.toggle('collapsed');
      this.textContent = sec.classList.contains('collapsed') ? '▸' : '▾';
    });
    sec.querySelector('.loc-head').addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      focusLocality(loc);
    });
    var refresh = sec.querySelector('.loc-refresh');
    if (refresh) {
      refresh.addEventListener('click', function (e) {
        e.preventDefault();
        var q = loc.query;
        var hist = loadHistory().filter(function (h) { return slugOf(h.q) !== slugOf(q); });
        try { localStorage.setItem(HKEY, JSON.stringify(hist)); } catch (err) {}
        removeLocality(loc);
        addLocality(q);
      });
    }

    var walkList = sec.querySelector('.walk-list');
    if (loc.result.status === 'none') {
      var none = document.createElement('div');
      none.className = 'loc-note';
      none.textContent = 'No significant pedestrian streets, squares or waterfront walkways are mapped here — or the area is under-mapped in OSM.';
      walkList.appendChild(none);
    }

    loc.result.areas.forEach(function (area, i) {
      var color = RANK_COLORS[i % RANK_COLORS.length];
      var layers = [];
      if (area.hull.length >= 3) {
        layers.push(L.polygon(area.hull, { color: color, weight: 2, fillColor: color, fillOpacity: 0.10, dashArray: '6 4' }));
      }
      area.highlightWays.forEach(function (w) {
        if (w.kind === 'square' && w.coords.length > 3) {
          layers.push(L.polygon(w.coords, { color: color, weight: 3, fillColor: color, fillOpacity: 0.25 }));
        } else {
          layers.push(L.polyline(w.coords, { color: color, weight: 5, opacity: 0.85 }));
        }
      });
      var group = L.featureGroup(layers);
      group.bindPopup('<b>#' + (i + 1) + ' ' + escapeHtml(area.label) + '</b><br>' + escapeHtml(evidenceLine(area.evidence)));
      loc.walkGroup.addLayer(group);

      var ev = area.evidence;
      var trafficFree = ev.pedestrianMeters + ev.parkPathMeters + ev.footpathMeters;
      var kidFriendly = trafficFree >= 300 &&
        (ev.playgrounds >= 1 || ev.furniture >= 5 || (ev.park && trafficFree >= 500));
      var kidBits = [];
      if (ev.playgrounds >= 1) kidBits.push(ev.playgrounds === 1 ? '1 playground' : ev.playgrounds + ' playgrounds');
      if (ev.furniture >= 5) kidBits.push(ev.furniture + ' benches');
      kidBits.push('car-free walking');

      var lat = area.center[0].toFixed(6), lon = area.center[1].toFixed(6);
      var gmapsLoc = 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lon;
      var amapsLoc = 'https://maps.apple.com/?ll=' + lat + ',' + lon + '&q=' + encodeURIComponent(area.label);
      var gmapsDir = 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lon;

      var card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('data-names', area.names.join(' ') + ' ' + area.label);
      card.innerHTML =
        '<div class="card-head"><span class="rank" style="background:' + color + '">' + (i + 1) + '</span>' +
        '<span class="card-title">' + escapeHtml(area.label) + '</span></div>' +
        (kidFriendly ? '<div class="card-kids">🛝 Kid-friendly — ' + kidBits.join(', ') + '</div>' : '') +
        (area.names.length > 2 ? '<div class="card-names">also: ' + escapeHtml(area.names.slice(2).join(', ')) + '</div>' : '') +
        '<div class="card-evidence">' + escapeHtml(evidenceLine(ev)) + '</div>' +
        '<div class="card-actions">' +
          '<a href="' + gmapsLoc + '" target="_blank" rel="noopener">Google&nbsp;Maps&nbsp;→</a>' +
          '<a href="' + amapsLoc + '" target="_blank" rel="noopener">Apple&nbsp;Maps&nbsp;→</a>' +
          '<a class="secondary" href="' + gmapsDir + '" target="_blank" rel="noopener">directions</a>' +
        '</div>';
      card.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        selectCard(card, group);
      });
      group.on('click', function () { lastLayerClick = Date.now(); flashCard(card); });
      walkList.appendChild(card);
    });

    if (layersOn.walk) loc.walkGroup.addTo(map);
    applyLayerVisibility();
  }

  function loadGemsFor(loc) {
    var eatList = loc.el.querySelector('.eat-list');
    var head = document.createElement('div');
    head.className = 'eat-head';
    head.textContent = '☕ Owner-run food & coffee';
    eatList.appendChild(head);

    fetchStaticGems(loc.query).catch(function () { return fetchStaticGems(loc.label); })
      .then(function (places) { renderGems(loc, places); })
      .catch(function () {
        var note = document.createElement('div');
        note.className = 'loc-note';
        if (AGENT_ENDPOINTS.length) {
          note.innerHTML = 'Not researched yet. ';
          var btn = document.createElement('button');
          btn.className = 'research-btn';
          btn.textContent = 'Research now (≈5 min)';
          btn.addEventListener('click', function () {
            btn.disabled = true;
            btn.textContent = 'Researching…';
            fetchLiveGems(loc.query)
              .then(function (places) { note.remove(); renderGems(loc, places); })
              .catch(function (err) { btn.textContent = 'Failed: ' + err.message; });
          });
          note.appendChild(btn);
        } else {
          note.textContent = 'Not researched yet for this locality (research runs on the Mac mini).';
        }
        eatList.appendChild(note);
      });
  }

  function renderGems(loc, places) {
    loc.gems = places;
    var eatList = loc.el.querySelector('.eat-list');
    if (!places.length) {
      var none = document.createElement('div');
      none.className = 'loc-note';
      none.textContent = 'No confirmed owner-run places found here.';
      eatList.appendChild(none);
      return;
    }
    var i = 0;
    places.forEach(function (p) {
      var gq = encodeURIComponent(p.name + ', ' + loc.label);
      var card = document.createElement('div');
      card.className = 'card gem';
      card.innerHTML =
        '<div class="card-head"><span class="gem-dot conf-' + (p.confidence || 'low') + '"></span>' +
        '<span class="card-title">' + escapeHtml(p.name) + '</span>' +
        '<span class="gem-type">' + escapeHtml(p.type || '') + '</span></div>' +
        (p.area ? '<div class="card-names">' + escapeHtml(p.area) + '</div>' : '') +
        '<div class="card-evidence">' + escapeHtml(p.evidence || '') + '</div>' +
        '<div class="card-actions">' +
          '<a href="https://www.google.com/maps/search/?api=1&query=' + gq + '" target="_blank" rel="noopener">Google&nbsp;Maps&nbsp;→</a>' +
          '<a class="secondary" href="https://maps.apple.com/?q=' + gq + '" target="_blank" rel="noopener">Apple&nbsp;Maps</a>' +
        '</div>';
      eatList.appendChild(card);
      p._card = card;
    });
    // geocode pins politely (Nominatim: 1 req/s)
    (function next() {
      if (i >= places.length) return;
      var p = places[i++];
      fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' +
        encodeURIComponent(p.name + ', ' + loc.label))
        .then(function (r) { return r.json(); })
        .then(function (list) {
          if (list.length) {
            var m = L.circleMarker([Number(list[0].lat), Number(list[0].lon)], {
              radius: 8, color: '#f59e0b', weight: 2, fillColor: '#fbbf24', fillOpacity: 0.85
            });
            m.bindTooltip('☕ ' + p.name);
            m.bindPopup('<b>' + escapeHtml(p.name) + '</b><br>' + escapeHtml(p.evidence || '') +
              '<br><a href="https://www.google.com/maps/search/?api=1&query=' +
              encodeURIComponent(p.name + ', ' + loc.label) + '" target="_blank" rel="noopener">Google Maps →</a>');
            m.on('click', function () {
              lastLayerClick = Date.now();
              if (p._card) flashCard(p._card);
            });
            p._card.addEventListener('click', function (e) {
              if (e.target.closest('a')) return;
              selectCard(p._card, null);
              map.setView(m.getLatLng(), 16);
              m.openPopup();
            });
            loc.eatGroup.addLayer(m);
          }
        })
        .catch(function () { /* skip pin */ })
        .finally(function () { setTimeout(next, 1100); });
    })();
    if (layersOn.eat) loc.eatGroup.addTo(map);
    applyLayerVisibility();
  }

  // ---------- layer toggles ----------

  function applyLayerVisibility() {
    loaded.forEach(function (loc) {
      if (layersOn.walk) { if (!map.hasLayer(loc.walkGroup)) loc.walkGroup.addTo(map); }
      else map.removeLayer(loc.walkGroup);
      if (layersOn.eat) { if (!map.hasLayer(loc.eatGroup)) loc.eatGroup.addTo(map); }
      else map.removeLayer(loc.eatGroup);
      if (loc.el) {
        loc.el.querySelector('.walk-list').style.display = layersOn.walk ? '' : 'none';
        var eat = loc.el.querySelector('.eat-list');
        if (eat) eat.style.display = layersOn.eat ? '' : 'none';
      }
    });
    $('layer-walk').classList.toggle('off', !layersOn.walk);
    $('layer-eat').classList.toggle('off', !layersOn.eat);
  }

  // ---------- explorer (landing state: researched + visited) ----------

  function renderExplorer() {
    explorerLayer.clearLayers();
    var listEl = $('explore-list');
    listEl.innerHTML = '';
    var loadedKeys = {};
    loaded.forEach(function (l) { loadedKeys[l.key] = 1; loadedKeys[slugOf(l.label)] = 1; });

    var visited = loadHistory();
    var visitedByKey = {};
    visited.forEach(function (h) { visitedByKey[slugOf(shortName(h.place))] = h; });

    var rows = [];
    researchedIndex.forEach(function (r) {
      var k = slugOf(r.label);
      rows.push({ key: k, label: r.label, lat: r.lat, lon: r.lon, gems: r.count,
        visited: !!visitedByKey[k], query: r.label + ', Romania' });
      delete visitedByKey[k];
    });
    Object.keys(visitedByKey).forEach(function (k) {
      var h = visitedByKey[k];
      rows.push({ key: k, label: shortName(h.place), lat: Number(h.place.lat), lon: Number(h.place.lon),
        gems: 0, visited: true, query: h.q });
    });
    rows.sort(function (a, b) { return a.label.localeCompare(b.label, 'ro'); });

    var rG = isTouch ? 9 : 6, rV = isTouch ? 8 : 5;
    rows.forEach(function (row) {
      if (loadedKeys[row.key]) return;
      var m = L.circleMarker([row.lat, row.lon], row.gems
        ? { radius: rG, color: '#b45309', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.7 }
        : { radius: rV, color: '#0f766e', weight: 2, fillColor: '#14b8a6', fillOpacity: 0.6 });
      m.bindTooltip(row.label + (row.gems ? ' · ☕ ' + row.gems : ''));
      m.on('click', function () { lastLayerClick = Date.now(); addLocality(row.query); });
      explorerLayer.addLayer(m);

      var el = document.createElement('div');
      el.className = 'explore-row';
      el.innerHTML = '<span class="explore-name">' + escapeHtml(row.label) + '</span>' +
        '<span class="explore-badges">' +
        (row.gems ? '<span class="badge-gems">☕ ' + row.gems + '</span>' : '') +
        (row.visited ? '<span class="badge-visited">✓ visited</span>' : '') +
        '</span>';
      el.addEventListener('click', function () { addLocality(row.query); });
      listEl.appendChild(el);
    });
    $('clear-all').style.display = loaded.length ? '' : 'none';
    // first paint with nothing loaded: frame the whole explorer dataset
    if (!loaded.length && rows.length && !renderExplorer._framed) {
      renderExplorer._framed = true;
      var pts = rows.map(function (r) { return [r.lat, r.lon]; });
      map.fitBounds(L.latLngBounds(pts).pad(0.12));
    }
  }

  function loadResearchedIndex() {
    return fetch('gems/index.json')
      .then(function (r) { if (!r.ok) throw new Error('none'); return r.json(); })
      .then(function (d) {
        if (d && Array.isArray(d.localities)) researchedIndex = d.localities;
      })
      .catch(function () { /* no dataset */ });
  }

  // ---------- near me ----------

  function searchNearMe() {
    if (!navigator.geolocation) { setStatus('Geolocation is not available in this browser.'); return; }
    setStatus('Locating you…', true);
    navigator.geolocation.getCurrentPosition(function (pos) {
      fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=13&lat=' +
        pos.coords.latitude + '&lon=' + pos.coords.longitude)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var a = d.address || {};
          var locality = a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb;
          if (!locality) throw new Error('Could not work out which locality you are in.');
          var q = locality + (a.county ? ', ' + a.county : '') + (a.country ? ', ' + a.country : '');
          $('q').value = q;
          addLocality(q);
        })
        .catch(function (err) { setStatus(err.message || 'Reverse geocoding failed.'); });
    }, function (err) {
      setStatus(err.code === 1 ? 'Location permission denied.' :
        'Could not get your location. Note: location needs the https version.');
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  }

  // ---------- boot ----------

  document.addEventListener('DOMContentLoaded', function () {
    initMap();
    $('go').addEventListener('click', function () { addLocality($('q').value); $('q').value = ''; });
    $('near').addEventListener('click', searchNearMe);
    $('q').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { addLocality($('q').value); $('q').value = ''; }
    });
    $('layer-walk').addEventListener('click', function () { layersOn.walk = !layersOn.walk; applyLayerVisibility(); });
    $('layer-eat').addEventListener('click', function () { layersOn.eat = !layersOn.eat; applyLayerVisibility(); });
    $('clear-all').addEventListener('click', function () {
      loaded.slice().forEach(removeLocality);
    });
    $('sheet-handle').addEventListener('click', function () {
      document.body.classList.toggle('sheet-open');
    });
    document.querySelectorAll('.example').forEach(function (el) {
      el.addEventListener('click', function () { addLocality(el.textContent); });
    });

    loadResearchedIndex().then(function () {
      renderExplorer();
      var params = new URLSearchParams(location.search);
      var p = params.get('p');
      var legacyQ = params.get('q');
      if (p) p.split('|').forEach(function (q) { addLocality(q); });
      else if (legacyQ) legacyQ.split(';').forEach(function (q) { addLocality(q); });
    });
  });
})();
