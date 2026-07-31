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
// light abuse guard for the public tunnel: shared token + hourly cap on live runs
const TOKEN = 'pf-7c1d9a4e2b8f4d61';
const MAX_LIVE_PER_HOUR = 4;
let liveRuns = []; // timestamps of live research starts
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

function gemsPrompt(place) {
  return 'Find restaurants, cafés and bistros in "' + place + '" that are OWNER-OPERATED ' +
    'PERSONAL PROJECTS — the owner is typically present in the location, running and often ' +
    'serving; NOT franchises, NOT chains, NOT investor-run groups. Use web search to verify: ' +
    'reviews mentioning the owner by name or presence (ro: proprietarul, patronul, gazda), ' +
    'interviews with founders, local-press articles about the place as a personal project. ' +
    'Up to 10. Be strict and honest: OMIT places you cannot support with evidence. ' +
    'Reply with ONLY compact JSON, no prose, no code fences: ' +
    '{"places":[{"name":"...","type":"cafe|restaurant|bistro|bar","area":"street/neighborhood",' +
    '"evidence":"one line: what confirms owner presence","confidence":"high|medium|low"}]}';
}

function askClaude(promptText, opts) {
  opts = opts || {};
  // NB: --allowedTools is variadic and would swallow a trailing prompt argument,
  // so it must be followed by another --flag before the positional prompt.
  const args = ['-p'];
  if (opts.tools) args.push('--allowedTools', opts.tools);
  args.push('--output-format', 'text', promptText);
  return new Promise((resolve, reject) => {
    execFile(CLAUDE_BIN, args,
      { timeout: opts.timeout || TIMEOUT_MS, env: ENV, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error('claude CLI failed: ' + err.message));
        const m = String(stdout).match(/\{[\s\S]*\}/);
        if (!m) return reject(new Error('no JSON in claude output'));
        try {
          const parsed = JSON.parse(m[0]);
          const key = opts.listKey || 'areas';
          if (!Array.isArray(parsed[key])) throw new Error('missing ' + key + '[]');
          const out = { generatedAt: new Date().toISOString() };
          out[key] = parsed[key].slice(0, opts.max || 5);
          resolve(out);
        } catch (e) {
          reject(new Error('bad JSON from claude: ' + e.message));
        }
      });
  });
}

function cached(kind, place, run) {
  const slug = slugify(place);
  if (!slug) return Promise.reject(new Error('empty place'));
  const key = kind + ':' + slug;
  const cacheFile = path.join(CACHE_DIR, (kind === 'suggest' ? '' : kind + '-') + slug + '.json');
  if (fs.existsSync(cacheFile)) {
    return Promise.resolve(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
  }
  if (inFlight.has(key)) return inFlight.get(key);
  const p = run().then((result) => {
    fs.writeFileSync(cacheFile, JSON.stringify(result));
    inFlight.delete(key);
    return result;
  }).catch((e) => { inFlight.delete(key); throw e; });
  inFlight.set(key, p);
  return p;
}

function suggest(place) {
  return cached('suggest', place, () => askClaude(prompt(place)));
}

function gems(place) {
  return cached('gems', place, () => askClaude(gemsPrompt(place), {
    tools: 'WebSearch,WebFetch', timeout: 420_000, listKey: 'places', max: 10
  }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/health') { return res.end(JSON.stringify({ ok: true })); }
  if (url.pathname !== '/suggest' && url.pathname !== '/gems' && url.pathname !== '/feedback') {
    res.writeHead(404); return res.end('{"error":"not found"}');
  }
  if (url.searchParams.get('k') !== TOKEN) {
    res.writeHead(403); return res.end('{"error":"forbidden"}');
  }

  // user feedback on results — appended to data/feedback.jsonl, reviewed later
  // to recalibrate the system (the Piatra Neamț loop, productized)
  if (url.pathname === '/feedback') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        try {
          const entry = JSON.parse(body);
          entry.receivedAt = new Date().toISOString();
          fs.appendFileSync(path.join(CACHE_DIR, 'feedback.jsonl'), JSON.stringify(entry) + '\n');
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400); res.end('{"error":"bad feedback"}');
        }
      });
      return;
    }
    // GET: review the collected feedback
    try {
      const lines = fs.readFileSync(path.join(CACHE_DIR, 'feedback.jsonl'), 'utf8')
        .trim().split('\n').slice(-200).map((l) => JSON.parse(l));
      return res.end(JSON.stringify({ count: lines.length, entries: lines }));
    } catch (e) {
      return res.end('{"count":0,"entries":[]}');
    }
  }
  const place = (url.searchParams.get('place') || '').trim().slice(0, 120);
  if (!place) { res.writeHead(400); return res.end('{"error":"missing place"}'); }

  if (url.pathname === '/suggest') {
    return suggest(place).then((result) => { res.end(JSON.stringify(result)); })
      .catch((e) => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
  }

  // /gems is async: Cloudflare cuts requests at ~100 s but research takes minutes.
  // Cache hit → 200 with data. Otherwise kick off (or join) the run and reply 202;
  // the client polls until the cache file exists.
  const slug = slugify(place);
  const cacheFile = path.join(CACHE_DIR, 'gems-' + slug + '.json');
  const altCache = path.join(CACHE_DIR, 'gems-' + slug + '-romania.json');
  if (fs.existsSync(cacheFile) || fs.existsSync(altCache)) {
    return res.end(fs.readFileSync(fs.existsSync(cacheFile) ? cacheFile : altCache, 'utf8'));
  }
  const inflightKey = 'gems:' + slug;
  if (!inFlight.has(inflightKey)) {
    const now = Date.now();
    liveRuns = liveRuns.filter((t) => now - t < 3600_000);
    if (liveRuns.length >= MAX_LIVE_PER_HOUR) {
      res.writeHead(429);
      return res.end('{"error":"research limit reached — try again in a while"}');
    }
    liveRuns.push(now);
    gems(place).catch((e) => console.error('gems run failed:', place, e.message));
  }
  res.writeHead(202);
  res.end(JSON.stringify({ running: true }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('promenade-agent listening on :' + PORT);
});
