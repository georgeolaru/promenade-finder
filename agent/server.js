// promenade-agent — tiny HTTP service that asks the local Claude CLI what it knows
// about a locality's promenade areas. Advisory layer only: the web app treats these
// as local-knowledge hints to confirm/re-rank deterministic OSM results.
//
// Runs on the Mac mini (port 3041) via LaunchAgent com.georgeolaru.promenade-agent.
// No npm dependencies. Responses are cached on disk per locality.
'use strict';

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3041;
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/opt/homebrew/bin/claude';
const CACHE_DIR = path.join(__dirname, 'data');
const TIMEOUT_MS = 180_000;
const ENV = Object.assign({}, process.env, {
  PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
});

fs.mkdirSync(CACHE_DIR, { recursive: true });

const inFlight = new Map(); // slug -> Promise

function slugify(q) {
  return q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function prompt(place) {
  return 'You are a local-knowledge assistant. For the locality "' + place + '", ' +
    'list the main promenade areas — the specific places where locals actually stroll, ' +
    'socialize and hang out for leisure (pedestrian streets, central parks, waterfronts, ' +
    'squares, ștrand/lido areas). Rank by real-life importance. Use names as they would ' +
    'appear on a map (OpenStreetMap naming if known). Be honest: OMIT places you are not ' +
    'reasonably sure about; an empty list is a valid answer for localities you do not know. ' +
    'Maximum 5. Reply with ONLY compact JSON, no prose, no code fences: ' +
    '{"areas":[{"name":"...","why":"one line","confidence":"high|medium|low"}]}';
}

function askClaude(place) {
  return new Promise((resolve, reject) => {
    execFile(CLAUDE_BIN, ['-p', '--output-format', 'text', prompt(place)],
      { timeout: TIMEOUT_MS, env: ENV, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error('claude CLI failed: ' + err.message));
        const m = String(stdout).match(/\{[\s\S]*\}/);
        if (!m) return reject(new Error('no JSON in claude output'));
        try {
          const parsed = JSON.parse(m[0]);
          if (!Array.isArray(parsed.areas)) throw new Error('missing areas[]');
          resolve({ areas: parsed.areas.slice(0, 5), generatedAt: new Date().toISOString() });
        } catch (e) {
          reject(new Error('bad JSON from claude: ' + e.message));
        }
      });
  });
}

function suggest(place) {
  const slug = slugify(place);
  if (!slug) return Promise.reject(new Error('empty place'));
  const cacheFile = path.join(CACHE_DIR, slug + '.json');
  if (fs.existsSync(cacheFile)) {
    return Promise.resolve(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
  }
  if (inFlight.has(slug)) return inFlight.get(slug);
  const p = askClaude(place).then((result) => {
    fs.writeFileSync(cacheFile, JSON.stringify(result));
    inFlight.delete(slug);
    return result;
  }).catch((e) => { inFlight.delete(slug); throw e; });
  inFlight.set(slug, p);
  return p;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/health') { return res.end(JSON.stringify({ ok: true })); }
  if (url.pathname !== '/suggest') { res.writeHead(404); return res.end('{"error":"not found"}'); }
  const place = (url.searchParams.get('place') || '').trim().slice(0, 120);
  if (!place) { res.writeHead(400); return res.end('{"error":"missing place"}'); }
  suggest(place).then((result) => {
    res.end(JSON.stringify(result));
  }).catch((e) => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('promenade-agent listening on :' + PORT);
});
