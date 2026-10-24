// Segment Conquer - local server.
// Handles Strava OAuth (needs the client secret, so it can't live in the browser),
// proxies the few Strava API endpoints the app uses, and caches responses on disk
// so re-syncing doesn't burn through Strava's rate limits.

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, '.env');
if (fsSync.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.json');
fsSync.mkdirSync(CACHE_DIR, { recursive: true });

const STRAVA_API = 'https://www.strava.com/api/v3';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TTL = {
  athlete: DAY,
  activityList: 10 * MINUTE,
  activity: Infinity, // efforts on a finished activity don't change
  segment: 7 * DAY,
  starred: 30 * MINUTE,
  explore: 7 * DAY,
};

const isConfigured = () => Boolean(CLIENT_ID && CLIENT_SECRET);
const pendingStates = new Set();
let rate = null; // last seen rate-limit headers

// ---------- tokens ----------

async function readTokens() {
  try {
    return JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function writeTokens(tokens) {
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

async function tokenRequest(params) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  if (!res.ok) throw httpError(res.status, `Strava token request failed: ${await res.text()}`);
  return res.json();
}

async function getAccessToken() {
  const tokens = await readTokens();
  if (!tokens) throw httpError(401, 'Not connected to Strava');
  if (tokens.expires_at - 60 > Date.now() / 1000) return tokens.access_token;

  const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  await writeTokens({ ...tokens, ...fresh });
  return fresh.access_token;
}

// ---------- Strava API + cache ----------

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function recordRate(headers) {
  const parse = (v) => (v ? v.split(',').map(Number) : null);
  const limit = parse(headers.get('x-readratelimit-limit') || headers.get('x-ratelimit-limit'));
  const usage = parse(headers.get('x-readratelimit-usage') || headers.get('x-ratelimit-usage'));
  if (limit && usage) {
    rate = { short: { used: usage[0], limit: limit[0] }, daily: { used: usage[1], limit: limit[1] }, at: Date.now() };
  }
}

async function stravaGet(pathname, params = {}) {
  const url = new URL(STRAVA_API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${await getAccessToken()}` } });
  recordRate(res.headers);
  if (res.status === 429) throw httpError(429, 'Strava rate limit reached. Wait ~15 minutes and sync again.');
  if (res.status === 401) throw httpError(401, 'Strava rejected the token. Reconnect your account.');
  if (!res.ok) throw httpError(res.status, `Strava ${pathname} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

const cacheFile = (key) => path.join(CACHE_DIR, key.replace(/[^a-z0-9_.-]/gi, '_') + '.json');

async function cached(key, ttl, force, load) {
  let entry = null;
  try {
    entry = JSON.parse(await fs.readFile(cacheFile(key), 'utf8'));
  } catch {}

  if (entry && !force && Date.now() - entry.fetchedAt < ttl) {
    return { data: entry.data, cached: true, fetchedAt: entry.fetchedAt };
  }
  try {
    const data = await load();
    const fetchedAt = Date.now();
    await fs.writeFile(cacheFile(key), JSON.stringify({ fetchedAt, data }));
    return { data, cached: false, fetchedAt };
  } catch (err) {
    // Stale data beats no data when Strava says slow down.
    if (entry && err.status === 429) return { data: entry.data, cached: true, stale: true, fetchedAt: entry.fetchedAt };
    throw err;
  }
}

// ---------- trimming (keep only what the UI needs) ----------

function trimSegmentSummary(s) {
  return {
    id: s.id,
    name: s.name,
    activity_type: s.activity_type,
    distance: s.distance,
    average_grade: s.average_grade,
    city: s.city,
    country: s.country,
    start_latlng: s.start_latlng,
    private: s.private,
    hazardous: s.hazardous,
  };
}

function trimActivity(a) {
  return {
    id: a.id,
    name: a.name,
    sport_type: a.sport_type || a.type,
    start_date: a.start_date,
    efforts: (a.segment_efforts || []).map((e) => ({
      segment_id: e.segment.id,
      elapsed_time: e.elapsed_time,
      kom_rank: e.kom_rank,
      pr_rank: e.pr_rank,
      start_date: e.start_date,
      segment: trimSegmentSummary(e.segment),
    })),
  };
}

function trimSegment(s) {
  return {
    ...trimSegmentSummary(s),
    maximum_grade: s.maximum_grade,
    total_elevation_gain: s.total_elevation_gain,
    climb_category: s.climb_category,
    state: s.state,
    end_latlng: s.end_latlng,
    effort_count: s.effort_count,
    athlete_count: s.athlete_count,
    star_count: s.star_count,
    polyline: s.map?.polyline || null,
    xoms: s.xoms || null,
    local_legend: s.local_legend ? { title: s.local_legend.title, effort_description: s.local_legend.effort_description } : null,
    athlete_pr: s.athlete_segment_stats
      ? {
          pr_elapsed_time: s.athlete_segment_stats.pr_elapsed_time,
          pr_date: s.athlete_segment_stats.pr_date,
          effort_count: s.athlete_segment_stats.effort_count,
        }
      : null,
  };
}

// ---------- routes ----------

async function api(route, url) {
  const force = url.searchParams.get('refresh') === '1';
  let m;

  if (route === '/api/status') {
    const tokens = await readTokens();
    return { configured: isConfigured(), connected: Boolean(tokens), redirect: `${BASE_URL}/auth/callback` };
  }
  if (route === '/api/rate') return rate;

  if (route === '/api/me') {
    return cached('athlete', TTL.athlete, force, async () => {
      const a = await stravaGet('/athlete');
      return { id: a.id, firstname: a.firstname, lastname: a.lastname, sex: a.sex, profile: a.profile_medium, city: a.city };
    });
  }

  if (route === '/api/activities') {
    const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 30, 1), 400);
    const perPage = Math.min(count, 100);
    const out = [];
    let anyFresh = false;
    for (let page = 1; out.length < count; page++) {
      const r = await cached(`activities-p${page}-n${perPage}`, TTL.activityList, force, () =>
        stravaGet('/athlete/activities', { per_page: perPage, page })
      );
      anyFresh ||= !r.cached;
      out.push(...r.data.map((a) => ({ id: a.id, name: a.name, sport_type: a.sport_type || a.type, start_date: a.start_date, distance: a.distance, manual: a.manual })));
      if (r.data.length < perPage) break;
    }
    return { data: out.slice(0, count), cached: !anyFresh };
  }

  if ((m = route.match(/^\/api\/activity\/(\d+)$/))) {
    return cached(`activity-${m[1]}`, TTL.activity, force, async () =>
      trimActivity(await stravaGet(`/activities/${m[1]}`, { include_all_efforts: true }))
    );
  }

  if ((m = route.match(/^\/api\/segment\/(\d+)$/))) {
    return cached(`segment-${m[1]}`, TTL.segment, force, async () => trimSegment(await stravaGet(`/segments/${m[1]}`)));
  }

  if (route === '/api/starred') {
    return cached('starred', TTL.starred, force, async () => {
      const all = [];
      for (let page = 1; page <= 5; page++) {
        const batch = await stravaGet('/segments/starred', { per_page: 200, page });
        all.push(...batch.map(trimSegmentSummary));
        if (batch.length < 200) break;
      }
      return all;
    });
  }

  // Saved routes are the discovery fallback when explore is refused: route details list every
  // segment along the route, including ones you have never ridden.
  if (route === '/api/routes') {
    return cached('routes', TTL.starred, force, async () => {
      const athleteId = (await readTokens())?.athlete_id || (await stravaGet('/athlete')).id;
      const all = [];
      for (let page = 1; page <= 2; page++) {
        const batch = await stravaGet(`/athletes/${athleteId}/routes`, { per_page: 50, page });
        all.push(...batch.map((r) => ({ id: r.id_str, name: r.name, distance: r.distance, type: r.type, private: r.private })));
        if (batch.length < 50) break;
      }
      return all;
    });
  }

  if ((m = route.match(/^\/api\/route\/(\d+)$/))) {
    return cached(`route-${m[1]}`, TTL.segment, force, async () => {
      const r = await stravaGet(`/routes/${m[1]}`);
      return { id: r.id_str, name: r.name, segments: (r.segments || []).map(trimSegmentSummary) };
    });
  }

  if (route === '/api/explore') {
    const bounds = (url.searchParams.get('bounds') || '').split(',').map(Number);
    if (bounds.length !== 4 || bounds.some((n) => !Number.isFinite(n))) throw httpError(400, 'bounds must be sw_lat,sw_lng,ne_lat,ne_lng');
    const type = url.searchParams.get('activity_type') === 'running' ? 'running' : 'riding';
    const b = bounds.map((n) => n.toFixed(3)).join(',');
    return cached(`explore-${type}-${b}`, TTL.explore, force, async () => {
      // Strava refuses this endpoint for some API apps even with a valid token. That is not a
      // logged-out state, so report it as its own error instead of a 401.
      const r = await stravaGet('/segments/explore', { bounds: b, activity_type: type }).catch((err) => {
        if (err.status === 401) throw httpError(403, 'Strava does not allow segment explore for this API app.', 'explore_unavailable');
        throw err;
      });
      return (r.segments || []).map((s) => ({
        id: s.id,
        name: s.name,
        activity_type: type === 'running' ? 'Run' : 'Ride',
        distance: s.distance,
        average_grade: s.avg_grade,
        start_latlng: s.start_latlng,
      }));
    });
  }

  throw httpError(404, 'Unknown API route');
}

async function handleAuth(route, url, res) {
  if (route === '/auth/login') {
    if (!isConfigured()) return send(res, 500, 'Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env first.');
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.add(state);
    const auth = new URL('https://www.strava.com/oauth/authorize');
    auth.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: `${BASE_URL}/auth/callback`,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: 'read,read_all,activity:read_all', // read_all includes private routes
      state,
    });
    return redirect(res, auth.toString());
  }

  if (route === '/auth/callback') {
    const state = url.searchParams.get('state');
    if (!pendingStates.delete(state)) return send(res, 400, 'Invalid OAuth state. Go back and try connecting again.');
    if (url.searchParams.get('error')) return redirect(res, '/?auth=denied');
    const scope = url.searchParams.get('scope') || '';
    const t = await tokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code') });
    await writeTokens({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at, scope, athlete_id: t.athlete?.id });
    return redirect(res, '/');
  }

  if (route === '/auth/logout') {
    await fs.rm(TOKEN_FILE, { force: true });
    await fs.rm(CACHE_DIR, { recursive: true, force: true });
    await fs.mkdir(CACHE_DIR, { recursive: true });
    return redirect(res, '/');
  }

  return send(res, 404, 'Not found');
}

// ---------- static files + plumbing ----------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function serveStatic(route, res) {
  const file = path.normalize(path.join(PUBLIC_DIR, route === '/' ? 'index.html' : route));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found');
  }
}

function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  const route = url.pathname;
  try {
    if (route.startsWith('/api/')) {
      const result = await api(route, url);
      return send(res, 200, JSON.stringify({ ...(result && 'data' in result ? result : { data: result }), rate }), 'application/json');
    }
    if (route.startsWith('/auth/')) return await handleAuth(route, url, res);
    return await serveStatic(route, res);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (route.startsWith('/api/')) return send(res, status, JSON.stringify({ error: err.message, code: err.code, rate }), 'application/json');
    send(res, status, err.message);
  }
});

server.listen(PORT, () => {
  console.log(`Segment Conquer running at ${BASE_URL}`);
  if (!isConfigured()) console.log('Missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET - copy .env.example to .env and fill them in.');
});
