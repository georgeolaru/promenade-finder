/*
 * promenade.js — pure analysis engine for Promenade Finder.
 * Takes raw Overpass elements, returns ranked promenade areas.
 * No DOM, no network: usable from the browser (window.Promenade) and Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Promenade = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CELL = 110;          // grid cell size in meters
  var SAMPLE_STEP = 25;    // way sampling step in meters
  var KEYWORD_RE = /(promenad|esplanad|boardwalk|corso|lungomare|malec[oó]n|falez|passeig|rambla\b|quai |sea ?front|strandwe|embankment)/i;

  var FOOD_RE = /^(cafe|restaurant|bar|pub|ice_cream|biergarten|fast_food)$/;
  var ATTRACTION_RE = /^(attraction|artwork|viewpoint|museum|gallery)$/;

  function classifyWay(tags) {
    if (!tags) return null;
    if (tags.place === 'square') return 'square';
    if (tags.highway === 'pedestrian') {
      return tags.area === 'yes' ? 'square' : 'pedestrian';
    }
    if (tags.highway === 'living_street') return 'living';
    if (tags.highway === 'footway' || tags.highway === 'path') {
      if (tags.footway === 'sidewalk' || tags.footway === 'crossing') return null;
      // hiking trails and informal paths are not promenades
      if (tags.sac_scale || tags.trail_visibility || tags.informal === 'yes') return null;
      if (!tags.name) return 'parkpath'; // unnamed ⇒ fetched by the inside-parks query block
      if (/trail|trase[ue]|hiking/i.test(tags.name)) return null;
      return 'footpath';
    }
    if (tags.natural === 'beach') return 'beach';
    if (tags.man_made === 'pier') return 'pier';
    if (tags.leisure === 'marina') return 'marina';
    if (tags.leisure === 'park' || tags.leisure === 'garden') return 'park';
    // leisure destinations where strolling/socializing happens (ștrand, lido, …)
    if (/^(water_park|beach_resort|swimming_area|recreation_ground)$/.test(tags.leisure || '')) return 'leisuredest';
    if (tags.landuse === 'recreation_ground') return 'leisuredest';
    if (FOOD_RE.test(tags.amenity || '')) return 'poi-food';
    if (tags.amenity === 'fountain') return 'poi-other';
    return null;
  }

  function classifyNode(tags) {
    if (!tags) return null;
    if (FOOD_RE.test(tags.amenity || '')) return 'poi-food';
    if (tags.amenity === 'fountain' || tags.leisure === 'bandstand') return 'poi-other';
    if (ATTRACTION_RE.test(tags.tourism || '')) return 'poi-other';
    if (tags.place === 'square') return 'square-node';
    return null;
  }

  // --- geometry helpers (local equirectangular projection) ---

  function makeProjection(lat0) {
    var kx = Math.cos(lat0 * Math.PI / 180) * 111320;
    var ky = 110540;
    return {
      toXY: function (lat, lon) { return [lon * kx, lat * ky]; },
      cellOf: function (lat, lon) {
        return [Math.floor(lon * kx / CELL), Math.floor(lat * ky / CELL)];
      }
    };
  }

  function dist(p, q) {
    var dx = p[0] - q[0], dy = p[1] - q[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  function polygonArea(xy) {
    var a = 0;
    for (var i = 0, n = xy.length; i < n; i++) {
      var j = (i + 1) % n;
      a += xy[i][0] * xy[j][1] - xy[j][0] * xy[i][1];
    }
    return Math.abs(a) / 2;
  }

  // Andrew monotone chain convex hull on [lat, lon] points
  function convexHull(points) {
    if (points.length < 3) return points.slice();
    var pts = points.slice().sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
    function cross(o, a, b) {
      return (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
    }
    var lower = [];
    for (var i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    var upper = [];
    for (var k = pts.length - 1; k >= 0; k--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[k]) <= 0) upper.pop();
      upper.push(pts[k]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  // --- main analysis ---

  function analyze(elements, opts) {
    opts = opts || {};
    var ways = [], pois = [], squareNodes = [];
    var latSum = 0, latN = 0;
    var seenWays = {};

    elements.forEach(function (el) {
      if (el.type === 'way' && seenWays[el.id]) return; // park-paths block may duplicate named ways
      if (el.type === 'way') seenWays[el.id] = true;
      if (el.type === 'way' && el.geometry && el.geometry.length > 1) {
        var kind = classifyWay(el.tags);
        if (!kind) return;
        if (kind === 'poi-food' || kind === 'poi-other') {
          var c = el.center || el.geometry[Math.floor(el.geometry.length / 2)];
          if (c) pois.push({ lat: c.lat, lon: c.lon, kind: kind, name: el.tags.name });
          return;
        }
        ways.push({
          id: el.id, kind: kind, tags: el.tags || {},
          name: (el.tags && el.tags.name) || null,
          coords: el.geometry.map(function (g) { return [g.lat, g.lon]; })
        });
        latSum += el.geometry[0].lat; latN++;
      } else if (el.type === 'node') {
        var nk = classifyNode(el.tags);
        if (!nk) return;
        if (nk === 'square-node') squareNodes.push({ lat: el.lat, lon: el.lon, name: el.tags.name });
        else pois.push({ lat: el.lat, lon: el.lon, kind: nk, name: el.tags && el.tags.name });
      } else if (el.type === 'way' && el.center) {
        var wk = classifyWay(el.tags);
        if (wk === 'poi-food' || wk === 'poi-other') {
          pois.push({ lat: el.center.lat, lon: el.center.lon, kind: wk, name: el.tags.name });
        }
      }
    });

    if (!ways.length && !pois.length) {
      return { status: 'none', areas: [], stats: { ways: 0, pois: 0 } };
    }

    var lat0 = latN ? latSum / latN : (pois[0] ? pois[0].lat : 0);
    var proj = makeProjection(lat0);

    // cells: key "cx,cy" -> accumulator
    var cells = {};
    function cell(cx, cy) {
      var k = cx + ',' + cy;
      var c = cells[k];
      if (!c) {
        c = cells[k] = {
          cx: cx, cy: cy, ped: 0, living: 0, foot: 0, square: 0,
          beach: 0, pier: 0, parkpath: 0, parkperim: 0, leisure: 0,
          food: 0, other: 0, water: false, park: false, keyword: false,
          wayLen: {}, samples: []
        };
      }
      return c;
    }

    ways.forEach(function (w) {
      var isKeyword = w.name ? KEYWORD_RE.test(w.name) : false;
      var closed = w.coords.length > 3 &&
        w.coords[0][0] === w.coords[w.coords.length - 1][0] &&
        w.coords[0][1] === w.coords[w.coords.length - 1][1];

      if (w.kind === 'square' && closed) {
        var xy = w.coords.map(function (p) { return proj.toXY(p[0], p[1]); });
        var area = polygonArea(xy);
        var clat = 0, clon = 0;
        w.coords.forEach(function (p) { clat += p[0]; clon += p[1]; });
        clat /= w.coords.length; clon /= w.coords.length;
        var cc = proj.cellOf(clat, clon);
        var c0 = cell(cc[0], cc[1]);
        c0.square += Math.min(Math.sqrt(area), 150);
        c0.samples.push([clat, clon]);
        if (w.name) c0.wayLen[w.id] = (c0.wayLen[w.id] || 0) + Math.sqrt(area);
        if (isKeyword) c0.keyword = true;
        return;
      }

      // sample along the polyline
      for (var i = 0; i < w.coords.length - 1; i++) {
        var a = proj.toXY(w.coords[i][0], w.coords[i][1]);
        var b = proj.toXY(w.coords[i + 1][0], w.coords[i + 1][1]);
        var segLen = dist(a, b);
        if (segLen === 0) continue;
        var steps = Math.max(1, Math.round(segLen / SAMPLE_STEP));
        var stepLen = segLen / steps;
        for (var s = 0; s < steps; s++) {
          var t = (s + 0.5) / steps;
          var lat = w.coords[i][0] + (w.coords[i + 1][0] - w.coords[i][0]) * t;
          var lon = w.coords[i][1] + (w.coords[i + 1][1] - w.coords[i][1]) * t;
          var cc2 = proj.cellOf(lat, lon);
          var c = cell(cc2[0], cc2[1]);
          if (w.kind === 'pedestrian') c.ped += stepLen;
          else if (w.kind === 'living') c.living += stepLen;
          else if (w.kind === 'footpath') c.foot += stepLen;
          else if (w.kind === 'parkpath') { c.parkpath += stepLen; c.park = true; }
          else if (w.kind === 'square') c.square += stepLen * 0.5;
          else if (w.kind === 'pier') { c.pier += stepLen; c.water = true; }
          else if (w.kind === 'beach') { c.beach += stepLen; c.water = true; }
          else if (w.kind === 'marina') { c.water = true; continue; }
          else if (w.kind === 'park') { c.parkperim += stepLen; c.park = true; }
          else if (w.kind === 'leisuredest') c.leisure += stepLen;
          c.samples.push([lat, lon]);
          if (w.name) c.wayLen[w.id] = (c.wayLen[w.id] || 0) + stepLen;
          if (isKeyword) c.keyword = true;
        }
      }
    });

    pois.forEach(function (p) {
      var cc = proj.cellOf(p.lat, p.lon);
      var c = cell(cc[0], cc[1]);
      if (p.kind === 'poi-food') c.food++;
      else c.other++;
    });
    squareNodes.forEach(function (p) {
      var cc = proj.cellOf(p.lat, p.lon);
      var c = cell(cc[0], cc[1]);
      c.square += 40;
      c.samples.push([p.lat, p.lon]);
    });

    // neighbor-aware scoring: cafés next door still count
    function neighborSum(c, field) {
      var total = 0;
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          var n = cells[(c.cx + dx) + ',' + (c.cy + dy)];
          if (n) total += n[field];
        }
      }
      return total;
    }

    var maxScore = 0;
    var keys = Object.keys(cells);
    keys.forEach(function (k) {
      var c = cells[k];
      var social = Math.min(neighborSum(c, 'food'), 25) + Math.min(neighborSum(c, 'other'), 8) * 0.5;
      // living streets are residential lanes unless there's social life around them
      var livingW = social > 0 ? 1.2 : 0.25;
      var walk = c.ped * 3.0 + c.living * livingW + c.foot * 0.9 + c.square * 2.0 +
                 c.pier * 2.5 + c.beach * 0.4 +
                 c.parkpath * 1.1 + c.parkperim * 0.3 + c.leisure * 0.6;
      var score;
      if (walk > 0) {
        score = walk * (1 + 0.10 * social);
        if (c.water) score *= 1.35;
        if (c.park) score *= 1.1;
        if (c.keyword) score *= 1.5;
      } else {
        // café/bar cluster without mapped pedestrian infra: the village-corso signal
        score = Math.min(social, 15) * 7;
      }
      c.score = score;
      if (score > maxScore) maxScore = score;
    });

    // cluster: flood-fill 8-connected cells above threshold
    var threshold = Math.max(60, maxScore * 0.12);
    var visited = {};
    var clusters = [];
    keys.forEach(function (k) {
      var c = cells[k];
      if (visited[k] || c.score < threshold) return;
      var queue = [k], members = [];
      visited[k] = true;
      while (queue.length) {
        var cur = cells[queue.pop()];
        members.push(cur);
        for (var dx = -1; dx <= 1; dx++) {
          for (var dy = -1; dy <= 1; dy++) {
            var nk = (cur.cx + dx) + ',' + (cur.cy + dy);
            if (!visited[nk] && cells[nk] && cells[nk].score >= threshold) {
              visited[nk] = true;
              queue.push(nk);
            }
          }
        }
      }
      clusters.push(members);
    });

    var wayById = {};
    ways.forEach(function (w) { wayById[w.id] = w; });

    var areas = clusters.map(function (members) {
      var total = 0, ped = 0, living = 0, foot = 0, food = 0, other = 0, beach = 0, pier = 0, parkpath = 0;
      var water = false, park = false, keyword = false;
      var wayLen = {}, samples = [];
      members.forEach(function (c) {
        total += c.score; ped += c.ped; living += c.living; foot += c.foot;
        beach += c.beach; pier += c.pier; parkpath += c.parkpath;
        food += c.food; other += c.other;
        water = water || c.water; park = park || c.park; keyword = keyword || c.keyword;
        Object.keys(c.wayLen).forEach(function (id) {
          wayLen[id] = (wayLen[id] || 0) + c.wayLen[id];
        });
        samples = samples.concat(c.samples);
      });

      var named = Object.keys(wayLen)
        .map(function (id) { return { way: wayById[id], len: wayLen[id] }; })
        .filter(function (x) { return x.way && x.way.name; });
      // squares first, then parks/leisure destinations, then by contributing length
      function labelPriority(w) {
        if (w.kind === 'square') return 2;
        if (w.kind === 'park' || w.kind === 'leisuredest') return 1;
        return 0;
      }
      named.sort(function (a, b) {
        return labelPriority(b.way) - labelPriority(a.way) || b.len - a.len;
      });
      var seen = {}, names = [];
      named.forEach(function (x) {
        if (!seen[x.way.name] && names.length < 4) { seen[x.way.name] = 1; names.push(x.way.name); }
      });

      var hull = convexHull(samples);
      var clat = 0, clon = 0;
      samples.forEach(function (p) { clat += p[0]; clon += p[1]; });
      if (samples.length) { clat /= samples.length; clon /= samples.length; }

      var highlightIds = {};
      named.slice(0, 12).forEach(function (x) { highlightIds[x.way.id] = true; });

      var fallbackLabel = 'Walkable area';
      if (!names.length) {
        if (water && food >= 5) fallbackLabel = 'Beachfront strip (bars & restaurants)';
        else if (water) fallbackLabel = 'Waterfront / beach strip';
        else if (food >= 5) fallbackLabel = 'Café & restaurant cluster';
      }
      return {
        score: Math.round(total),
        names: names,
        label: names.length ? names.slice(0, 2).join(' · ') : fallbackLabel,
        center: [clat, clon],
        hull: hull,
        cellCount: members.length,
        highlightWays: Object.keys(highlightIds).map(function (id) { return wayById[id]; }),
        evidence: {
          pedestrianMeters: Math.round(ped),
          livingStreetMeters: Math.round(living),
          footpathMeters: Math.round(foot),
          parkPathMeters: Math.round(parkpath),
          beachMeters: Math.round(beach),
          pierMeters: Math.round(pier),
          foodPlaces: food,
          otherPois: other,
          squares: named.filter(function (x) { return x.way.kind === 'square'; })
            .map(function (x) { return x.way.name; })
            .filter(function (v, i, arr) { return arr.indexOf(v) === i; }),
          waterfront: water,
          park: park,
          promenadeName: keyword
        }
      };
    });

    areas.sort(function (a, b) { return b.score - a.score; });
    areas = areas.filter(function (a) { return a.score >= 120 && a.cellCount >= 1; });

    // when the locality has no admin boundary (geocoded as a point), drop clusters
    // beyond its plausible extent — e.g. the next village's beach inside the bbox
    if (opts.center && opts.maxKm) {
      var cXY = proj.toXY(opts.center[0], opts.center[1]);
      areas = areas.filter(function (a) {
        var aXY = proj.toXY(a.center[0], a.center[1]);
        return dist(cXY, aXY) <= opts.maxKm * 1000;
      });
    }
    areas = areas.slice(0, 5);

    // verdict thresholds (calibrated against real localities, see test/calibrate.js).
    // "strong" needs social proof, not just walkable length — a long empty lane or
    // trail is not a promenade.
    function hasSocialProof(a) {
      var ev = a.evidence;
      return ev.foodPlaces >= 5 || ev.squares.length > 0 || ev.waterfront || ev.promenadeName ||
        ev.parkPathMeters >= 500; // a park laced with alleys is inherently a social space
    }
    var status;
    var best = areas.length ? areas[0] : null;
    if (best && best.score >= 1500 && hasSocialProof(best)) status = 'strong';
    else if (best && best.score >= 350) status = 'weak';
    else { status = 'none'; areas = []; }

    return {
      status: status,
      areas: areas,
      stats: { ways: ways.length, pois: pois.length, cells: keys.length, maxCell: Math.round(maxScore) }
    };
  }

  return { analyze: analyze, classifyWay: classifyWay, classifyNode: classifyNode, convexHull: convexHull, KEYWORD_RE: KEYWORD_RE };
});
