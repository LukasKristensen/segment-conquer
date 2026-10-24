// Segment Conquer - frontend.
// Pulls your activities' segment efforts plus segment details through the local server,
// estimates the 10th-place time per segment and ranks segments by how close you are.

const $ = (sel) => document.querySelector(sel);

// ---------- statuses ----------

const STATUS = {
  free: { label: 'Free top 10', color: '#22c55e', hint: 'Fewer than 10 athletes on this leaderboard. Just finish it.' },
  close: { label: 'Within 5%', color: '#4ade80', hint: 'Your PR is within 5% of the estimated 10th place.' },
  reach: { label: 'Within 15%', color: '#f59e0b', hint: 'A good day (or a tailwind) could do it.' },
  far: { label: '15%+ off', color: '#ef4444', hint: 'Needs a lot more speed than your current PR.' },
  unridden: { label: 'Not done yet', color: '#60a5fa', hint: 'You have no effort here yet, and there is not enough data to predict your time.' },
  top10: { label: 'Top 10', color: '#f5c542', hint: 'You are (or were, at upload time) in the top 10.' },
  unknown: { label: 'No data', color: '#6b7280', hint: 'Segment details not loaded yet, or Strava has no KOM time for it.' },
};

const CHIPS = [
  { key: 'targets', label: 'Best targets', statuses: ['free', 'close', 'reach'] },
  { key: 'free', label: STATUS.free.label, statuses: ['free'] },
  { key: 'close', label: STATUS.close.label, statuses: ['close'] },
  { key: 'reach', label: STATUS.reach.label, statuses: ['reach'] },
  { key: 'far', label: STATUS.far.label, statuses: ['far'] },
  { key: 'unridden', label: STATUS.unridden.label, statuses: ['unridden'] },
  { key: 'top10', label: STATUS.top10.label, statuses: ['top10'] },
  { key: 'all', label: 'All', statuses: null },
];

// Rough share of a segment's athletes on each gender leaderboard (athlete_count is not split by gender).
const FIELD_SHARE = { kom: 0.8, qom: 0.2, overall: 1 };

// ---------- settings (per-browser convenience only) ----------

const DEFAULTS = {
  scanCount: 30,
  mode: 'discover', // 'discover' = segments you haven't done, 'mine' = ones you have, 'all'
  discoverBudget: 25, // max fresh Strava explore calls per Discover click
  chip: 'targets',
  sport: 'all',
  compareTo: 'auto',
  sigma: 0.1,
  sort: { key: 'score', dir: 1 },
  home: null, // [lat, lng], only ever stored in this browser
  radiusKm: 20, // 0 = any distance
  overrides: {}, // segmentId -> actual 10th-place seconds
  explored: [], // legacy: discovered segments from before the database; migrated on load
  hasSynced: false,
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('sc.settings') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
const settings = loadSettings();
function saveSettings() {
  try {
    localStorage.setItem('sc.settings', JSON.stringify(settings));
  } catch {}
}

// ---------- data store ----------

// A mirror of the server's database. The server is the source of truth; loadLibrary() refreshes this.
const store = {
  athlete: null,
  summaries: new Map(), // segId -> summary (oldest first seen first)
  details: new Map(), // segId -> full segment detail
  detailFetchedAt: new Map(), // segId -> ms timestamp, to spot outdated KOM data
  efforts: new Map(), // segId -> { best, count, bestRank } across every stored activity
  sources: new Map(), // segId -> Set('ridden' | 'starred' | 'explore' | 'route')
};

// Shows a segment immediately while a discovery is running; the server stores it too.
function addSummary(seg, source) {
  if (!store.summaries.has(seg.id)) store.summaries.set(seg.id, seg);
  if (!store.sources.has(seg.id)) store.sources.set(seg.id, new Set());
  store.sources.get(seg.id).add(source);
}

async function loadLibrary() {
  const { data } = await api('/api/library');
  store.summaries = new Map();
  store.details = new Map();
  store.detailFetchedAt = new Map();
  store.sources = new Map();
  for (const s of data.segments) {
    store.summaries.set(s.summary.id, s.summary);
    if (s.detail) store.details.set(s.summary.id, s.detail);
    if (s.detailFetchedAt) store.detailFetchedAt.set(s.summary.id, s.detailFetchedAt);
    store.sources.set(s.summary.id, new Set(s.sources));
  }
  store.efforts = new Map(Object.entries(data.efforts).map(([id, e]) => [Number(id), e]));
}

const hasDiscovered = () => [...store.sources.values()].some((src) => src.has('explore') || src.has('route'));

// Older versions kept discovered segments only in this browser. Hand them to the database once.
async function migrateBrowserSegments() {
  if (!settings.explored?.length) return;
  await api('/api/library/import', { method: 'POST', body: JSON.stringify({ segments: settings.explored, source: 'explore' }) });
  settings.explored = [];
  saveSettings();
}

// ---------- API ----------

class StopSync extends Error {}

async function api(path, init) {
  const res = await fetch(path, init && { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await res.json().catch(() => ({}));
  if (body.rate) showRate(body.rate);
  if (res.status === 429) throw Object.assign(new StopSync(body.error || 'Strava rate limit reached.'), { retryAt: body.retryAt });
  if (res.status === 401) {
    showConnect();
    throw new StopSync(body.error || 'Not connected.');
  }
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { code: body.code });
  return body;
}

// Runs fn over items with limited concurrency. Rate limits / auth errors stop everything;
// other errors (e.g. a deleted activity) are logged and skipped.
async function pool(items, concurrency, fn) {
  let next = 0;
  let stop = null;
  async function worker() {
    while (next < items.length && !stop) {
      const idx = next++;
      try {
        await fn(items[idx], idx);
      } catch (err) {
        if (err instanceof StopSync) stop = err;
        else console.warn('Skipped item', items[idx], err);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (stop) throw stop;
}

// ---------- estimation ----------

// Inverse standard normal CDF (Acklam's approximation).
function invNorm(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - lo) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  return -invNorm(1 - p);
}

// Times ~ log-normal with spread sigma. With N athletes, rank k sits near quantile (k - 0.5) / N.
function estimate10th(komSeconds, field, sigma) {
  const z1 = invNorm(0.5 / field);
  const z10 = invNorm(9.5 / field);
  return komSeconds * Math.exp(sigma * (z10 - z1));
}

// ---------- personal speed model ----------
// Fits ln(speed) ~ uphill grade + downhill grade + ln(distance) over your PRs, per sport, then shifts
// it to your "good day" (75th percentile of residuals) so a predicted time is a realistic best effort.

let models = {};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const features = (s) => {
  const g = clamp(s.average_grade ?? 0, -10, 15);
  return [1, Math.max(g, 0), Math.min(g, 0), Math.log(s.distance)];
};
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);

// Ridge-regularised least squares via Gaussian elimination.
function leastSquares(xs, ys, ridge = 1e-3) {
  const k = xs[0].length;
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k + 1 }, (_, j) => (i === j && i > 0 ? ridge * xs.length : 0)));
  xs.forEach((x, r) => {
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j];
      A[i][k] += x[i] * ys[r];
    }
  });
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row, i) => row[k] / row[i]);
}

function fitModels() {
  models = {};
  for (const sport of ['Ride', 'Run']) {
    const xs = [];
    const ys = [];
    for (const [id, eff] of store.efforts) {
      // The effort's segment summary has distance and grade, so no detail request is needed here.
      const seg = store.details.get(id) || store.summaries.get(id);
      if (!seg || seg.activity_type !== sport || !(seg.distance >= 200)) continue;
      const pr = Math.min(eff.best, seg.athlete_pr?.pr_elapsed_time || Infinity);
      if (!Number.isFinite(pr) || pr <= 0) continue;
      xs.push(features(seg));
      ys.push(Math.log(seg.distance / pr));
    }
    if (xs.length < MIN_PRS) continue;
    // With few PRs, drop the distance term (grade only) so the fit stays stable.
    const k = xs.length >= 10 ? 4 : 3;
    const fx = xs.map((x) => x.slice(0, k));
    const beta = leastSquares(fx, ys);
    if (!beta) continue;
    const residuals = ys.map((y, i) => y - dot(beta, fx[i])).sort((a, b) => a - b);
    models[sport] = { beta, k, goodDay: residuals[Math.floor(residuals.length * 0.75)], n: xs.length };
  }
}
const MIN_PRS = 4;

function predictTime(seg) {
  const m = models[seg?.activity_type];
  if (!m || !(seg.distance > 0)) return null;
  return seg.distance / Math.exp(dot(m.beta, features(seg).slice(0, m.k)) + m.goodDay);
}

// Why a segment you haven't done has no predicted time, in words.
function noPredictionReason(seg) {
  if (!store.efforts.size) return 'Sync first: your speed is learned from the segments in your activities.';
  const sport = seg?.activity_type === 'Run' ? 'run' : 'ride';
  return `Not enough of your ${sport} PRs to predict your time (needs ${MIN_PRS}). Scan more activities with ${sport}s in them.`;
}

// Great-circle distance in km.
function haversineKm([lat1, lng1], [lat2, lng2]) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

const homeKmOf = (seg) => (settings.home && seg?.start_latlng?.length === 2 ? haversineKm(settings.home, seg.start_latlng) : null);

function boardFor() {
  if (settings.compareTo !== 'auto') return settings.compareTo;
  return store.athlete?.sex === 'F' ? 'qom' : 'kom';
}

function analyze(id) {
  const det = store.details.get(id);
  const seg = det || store.summaries.get(id);
  const eff = store.efforts.get(id);
  const board = boardFor();

  const prs = [eff?.best, det?.athlete_pr?.pr_elapsed_time].filter((t) => Number.isFinite(t) && t > 0);
  const pr = prs.length ? Math.min(...prs) : null;
  const predicted = pr == null && det ? predictTime(det) : null;
  const you = pr ?? predicted;
  const kom = det ? parseTime(det.xoms?.[board]) ?? parseTime(det.xoms?.overall) : null;
  const athletes = det?.athlete_count ?? null;
  const field = athletes != null ? Math.max(1, Math.round(athletes * FIELD_SHARE[board])) : null;

  let target = null;
  let targetSource = null;
  if (settings.overrides[id]) {
    target = settings.overrides[id];
    targetSource = 'manual';
  } else if (field != null && field < 10) {
    targetSource = 'free';
  } else if (kom && field) {
    target = estimate10th(kom, field, settings.sigma);
    targetSource = 'estimate';
  }

  let status;
  let gap = null;
  let gapPct = null;
  if (eff?.bestRank && eff.bestRank <= 10) status = 'top10';
  else if (targetSource === 'free') status = pr != null ? 'top10' : 'free';
  else if (target == null) status = 'unknown';
  else if (you == null) status = 'unridden';
  else {
    gap = you - target;
    gapPct = gap / target;
    status = gapPct <= 0.05 ? 'close' : gapPct <= 0.15 ? 'reach' : 'far';
  }

  // Lower is better: top-10 spots you hold come first (#1 before #10, then ones without a known rank),
  // then free spots, then real gaps.
  const top10Score = -2 + (eff?.bestRank ?? 15) / 100;
  const score = { top10: top10Score, free: -1, close: gapPct, reach: gapPct, far: gapPct, unridden: 10, unknown: 30 }[status];

  return { id, seg, det, eff, board, pr, predicted, homeKm: homeKmOf(seg), kom, athletes, field, target, targetSource, status, gap, gapPct, score };
}

// ---------- formatting ----------

function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim().toLowerCase();
  if (/^\d+(\.\d+)?\s*s$/.test(s)) return parseFloat(s);
  const parts = s.replace(/[^\d:.]/g, '').split(':').filter(Boolean).map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function fmtTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '-';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const fmtDist = (m) => (m == null ? '-' : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const fmtPct = (p) => (p == null ? '-' : `${p > 0 ? '+' : ''}${(p * 100).toFixed(1)}%`);
const fmtInt = (n) => (n == null ? '-' : n.toLocaleString());
const isRun = (seg) => seg?.activity_type === 'Run';

function fmtPace(seg, sec) {
  if (!seg?.distance || !sec) return '-';
  if (isRun(seg)) return `${fmtTime(sec / (seg.distance / 1000))} /km`;
  return `${((seg.distance / sec) * 3.6).toFixed(1)} km/h`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- sync ----------

let busy = false;

function setBusy(on) {
  busy = on;
  $('#sync-btn').disabled = on;
  $('#explore-btn').disabled = on;
  $('#update-btn').disabled = on;
  if (!on) $('#progress').style.width = '0';
}

function setStatus(text, isError = false) {
  const el = $('#status-text');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function setProgress(done, total) {
  $('#progress').style.width = total ? `${Math.round((done / total) * 200)}px` : '0';
}

// Fetches any of your last N activities not stored yet; returns how many were new.
async function checkActivities() {
  setStatus('Checking for new activities…');
  const { data: activities } = await api(`/api/activities?count=${settings.scanCount}`);
  const scannable = activities.filter((a) => !a.manual && !/virtual/i.test(a.sport_type || ''));
  // Each activity is stored by the server; already-stored ones cost nothing.
  let done = 0;
  let fresh = 0;
  await pool(scannable, 4, async (a) => {
    const { cached } = await api(`/api/activity/${a.id}`);
    if (!cached) fresh++;
    setProgress(++done, scannable.length);
    setStatus(`Checking activities ${done}/${scannable.length}${fresh ? `, ${fresh} new` : ''}`);
  });
  return fresh;
}

// `fresh` skips the 6-hour cache, so segments starred a minute ago in Strava show up.
async function checkStarred(fresh = false) {
  try {
    await api(`/api/starred${fresh ? '?refresh=1' : ''}`);
  } catch (err) {
    if (err instanceof StopSync) throw err;
    console.warn('Starred segments failed', err);
  }
}

async function sync() {
  if (busy) return;
  setBusy(true);
  try {
    await checkActivities();
    await checkStarred();
    await loadLibrary();
    settings.hasSynced = true;
    saveSettings();
    fitMapOnce();
    await loadDetails();
  } catch (err) {
    await loadLibrary().catch(() => {}); // show whatever was stored before the stop
    handleLoadError(err, sync);
  } finally {
    setBusy(false);
    render();
  }
}

// When Strava's budget runs out, wait for the window to reset and pick up where we stopped.
// Everything already fetched is cached, so re-running the action only costs the remaining requests.
let resumeTimer = null;
function handleLoadError(err, resume) {
  if (!err.retryAt) return setStatus(err.message, true);
  clearTimeout(resumeTimer);
  const at = new Date(err.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const left = err.left ? `${err.left} segment${err.left === 1 ? '' : 's'} still to load. ` : '';
  setStatus(`${err.message} ${left}Continuing automatically at ${at} (keep this tab open).`);
  resumeTimer = setTimeout(resume, Math.max(0, err.retryAt - Date.now()) + 5000);
}

// Details cost one request each, so only fetch them for segments the current view can show:
// "New to me" never shows segments you've ridden, and nothing outside the home radius is shown.
const needsDetail = (s) => insideRadiusFilter(s) && (settings.mode !== 'discover' || !store.efforts.has(s.id));

async function loadForView() {
  if (busy) return;
  setBusy(true);
  try {
    await loadDetails();
  } catch (err) {
    handleLoadError(err, loadForView);
  } finally {
    setBusy(false);
    render();
  }
}

const DETAIL_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // matches the server's segment TTL
const isOutdated = (id) => Date.now() - (store.detailFetchedAt.get(id) || 0) > DETAIL_MAX_AGE;

// Fetch full details (KOM, athlete count, polyline) for the segments the current view needs:
// missing ones first, then ones whose KOM data is over 30 days old. Everything else is skipped.
async function loadDetails(needs = needsDetail) {
  // Most-ridden first; among the rest, the most recently discovered first (those come from the
  // deepest, least popular map tiles, i.e. the softest leaderboards).
  const candidates = [...store.summaries.values()]
    .map((s, idx) => ({ s, idx, count: store.efforts.get(s.id)?.count || 0 }))
    .filter(({ s }) => !s.hazardous && !s.private && needs(s))
    .sort((a, b) => b.count - a.count || b.idx - a.idx)
    .map(({ s }) => s);
  const pending = [
    ...candidates.filter((s) => !store.details.has(s.id)),
    ...candidates.filter((s) => store.details.has(s.id) && isOutdated(s.id)),
  ];

  let done = 0;
  let fresh = 0;
  try {
    await pool(pending, 4, async (s) => {
      const { data, cached } = await api(`/api/segment/${s.id}`);
      store.details.set(s.id, data);
      if (!cached) {
        fresh++;
        store.detailFetchedAt.set(s.id, Date.now());
      }
      setProgress(++done, pending.length);
      setStatus(`Loading segment details ${done}/${pending.length}`);
      scheduleRender();
    });
    setStatus(`${store.details.size} segments analysed${fresh ? ` (${fresh} fetched from Strava)` : ''}.`);
  } catch (err) {
    err.left = pending.length - done;
    throw err;
  }
}

function discoverSport() {
  if (settings.sport !== 'all') return settings.sport;
  let rides = 0;
  let runs = 0;
  for (const id of store.efforts.keys()) {
    if (store.summaries.get(id)?.activity_type === 'Run') runs++;
    else rides++;
  }
  return runs > rides ? 'Run' : 'Ride';
}

// Map search can be refused for an API app. Remember that, but try again once a day in case
// Strava lifts it.
const DAY_MS = 24 * 60 * 60 * 1000;
const exploreBlocked = () => Boolean(settings.exploreBlocked) && Date.now() - (settings.exploreBlockedAt || 0) < DAY_MS;
function setExploreBlocked(blocked) {
  settings.exploreBlocked = blocked;
  settings.exploreBlockedAt = blocked ? Date.now() : 0;
  saveSettings();
  updateDiscoverButton();
}

// Strava's explore endpoint returns at most the 10 most popular segments in an area. Popular means
// crowded leaderboards, so whenever an area comes back full we split it into quarters and search
// again. The deeper tiles surface the quiet segments, which is where top-10 spots are easy.
// `wanted(tile)` can skip tiles entirely, e.g. ones outside the home radius.
async function sweep([s0, w0, n0, e0], type, wanted = () => true) {
  const queue = [[s0, w0, n0, e0]];
  const known = new Set(store.summaries.keys());
  let searches = 0;
  let fresh = 0;
  let found = 0;
  while (queue.length && fresh < settings.discoverBudget) {
    const tile = queue.shift();
    if (!wanted(tile)) continue;
    const [s, w, n, e] = tile;
    const { data, cached } = await api(`/api/explore?bounds=${tile.join(',')}&activity_type=${type}`);
    searches++;
    if (!cached) fresh++;
    for (const seg of data) {
      if (!known.has(seg.id)) found++;
      known.add(seg.id);
      addSummary(seg, 'explore');
    }
    if (data.length >= 10 && n - s > 0.004) {
      const midLat = (s + n) / 2;
      const midLng = (w + e) / 2;
      queue.push([s, w, midLat, midLng], [s, midLng, midLat, e], [midLat, w, n, midLng], [midLat, midLng, n, e]);
    }
    setProgress(fresh, settings.discoverBudget);
    setStatus(`Searched ${searches} area${searches === 1 ? '' : 's'}, ${found} new segment${found === 1 ? '' : 's'}…`);
    scheduleRender();
  }
  return { searches, found, unfinished: queue.length > 0 };
}

async function exploreArea() {
  if (busy || !map) return;
  if (exploreBlocked()) return discoverRoutes();
  const view = map.getBounds();
  if (view.getNorth() - view.getSouth() > 3) {
    setStatus('Zoom in to a city or region first; the map view is too large to sweep.', true);
    return;
  }
  setBusy(true);
  try {
    const sport = discoverSport();
    const { searches, found, unfinished } = await sweep(
      [view.getSouth(), view.getWest(), view.getNorth(), view.getEast()],
      sport === 'Run' ? 'running' : 'riding'
    );
    setExploreBlocked(false);
    await loadLibrary();
    await loadDetails(notDoneNearby);
    setStatus(
      `Discovered ${found} new ${sport.toLowerCase()} segment${found === 1 ? '' : 's'} in ${searches} searches.` +
        (unfinished ? ' Search budget used up; click Discover again to dig deeper.' : '') +
        hiddenHint('notDone')
    );
  } catch (err) {
    if (err.code === 'explore_unavailable') setExploreBlocked(true);
    else handleLoadError(err, exploreArea);
  } finally {
    setBusy(false);
    render();
  }
  if (exploreBlocked()) discoverRoutes();
}

// Reads every saved route (re-reading only edited ones) and returns how many segments were new.
async function readRoutes() {
  setStatus('Loading your saved routes…');
  const { data: routes } = await api('/api/routes');
  const known = new Set(store.summaries.keys());
  let done = 0;
  let found = 0;
  await pool(routes, 4, async (route) => {
    const { data } = await api(`/api/route/${route.id}${route.updated_at ? `?updated_at=${encodeURIComponent(route.updated_at)}` : ''}`);
    for (const seg of data.segments) {
      if (!known.has(seg.id)) found++;
      known.add(seg.id);
      addSummary(seg, 'route');
    }
    setProgress(++done, routes.length);
    setStatus(`Reading routes ${done}/${routes.length}, ${found} new segment${found === 1 ? '' : 's'}…`);
    scheduleRender();
  });
  return { routes: routes.length, found };
}

// Fallback discovery: every segment along the routes you've saved on Strava.
async function discoverRoutes() {
  if (busy) return;
  setBusy(true);
  try {
    const { routes, found } = await readRoutes();
    if (!routes) {
      setStatus('Strava blocks map search for this app, and you have no saved routes. Plan routes through new areas on strava.com/maps, then click Discover again.', true);
      return;
    }
    await loadLibrary();
    await loadDetails(notDoneNearby);
    setStatus(
      `Found ${found} new segment${found === 1 ? '' : 's'} on your ${routes} saved routes. ` +
        '(Strava blocks map search for this app, so plan routes through new areas on strava.com/maps to discover more.)' +
        hiddenHint('notDone')
    );
  } catch (err) {
    handleLoadError(err, discoverRoutes);
  } finally {
    setBusy(false);
    render();
  }
}

// Discoveries are segments you haven't done; they get details whatever mode is showing, but
// segments outside the home radius are still skipped.
const insideRadiusFilter = (s) => {
  const km = homeKmOf(s);
  return !settings.home || !settings.radiusKm || km == null || km <= settings.radiusKm;
};
const notDoneNearby = (s) => !store.efforts.has(s.id) && insideRadiusFilter(s);

// Discover and Update leave the mode alone; say so when their results are filtered out of the list.
function hiddenHint(kind) {
  if (settings.mode === 'all') return '';
  if (kind === 'notDone' && settings.mode === 'discover') return '';
  const label = { discover: 'New to me', mine: 'My segments' }[settings.mode];
  return kind === 'notDone'
    ? ` The list is set to "${label}"; pick "New to me" or "All segments" to see segments you haven't done.`
    : ` The list is set to "${label}"; pick "All segments" to see everything.`;
}

const inRadius = (seg) => {
  const km = homeKmOf(seg);
  return km != null && km <= settings.radiusKm;
};

// Bounding box of the home circle, and whether a map tile overlaps the circle at all.
function radiusBounds() {
  const [lat, lng] = settings.home;
  const dLat = settings.radiusKm / 111.32;
  const dLng = settings.radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [lat - dLat, lng - dLng, lat + dLat, lng + dLng];
}
function tileTouchesRadius([s, w, n, e]) {
  const [lat, lng] = settings.home;
  return haversineKm(settings.home, [clamp(lat, s, n), clamp(lng, w, e)]) <= settings.radiusKm;
}

// One button for everything that can turn up new segments near home: new activities, segments you
// starred in Strava (checked fresh every time), map search over the circle when Strava allows it
// (retried daily), and new or edited routes. Then details for every known segment in range.
async function updateNearHome() {
  if (busy || !settings.home || !settings.radiusKm) return;
  setBusy(true);
  const before = new Set(store.summaries.keys());
  try {
    const newActivities = await checkActivities();
    setStatus('Checking your starred segments…');
    await checkStarred(true);

    let mapSearch = '';
    if (!exploreBlocked()) {
      try {
        const sport = discoverSport();
        const { searches, unfinished } = await sweep(radiusBounds(), sport === 'Run' ? 'running' : 'riding', tileTouchesRadius);
        setExploreBlocked(false);
        mapSearch = ` Map search covered the radius in ${searches} searches${unfinished ? ' (budget used up; update again to dig deeper)' : ''}.`;
      } catch (err) {
        if (err.code !== 'explore_unavailable') throw err;
        setExploreBlocked(true);
      }
    }
    await readRoutes();

    await loadLibrary();
    render();
    await loadDetails(inRadius);

    const inside = [...store.summaries.values()].filter((s) => inRadius(s) && !s.hazardous && !s.private);
    const done = inside.filter((s) => store.efforts.has(s.id)).length;
    const fresh = inside.filter((s) => !before.has(s.id));
    const by = (src) => fresh.filter((s) => store.sources.get(s.id)?.has(src)).length;
    const parts = [
      newActivities && `${newActivities} new activit${newActivities === 1 ? 'y' : 'ies'}`,
      fresh.length && `${fresh.length} new segment${fresh.length === 1 ? '' : 's'} nearby (${by('starred')} starred, ${by('route')} on routes, ${by('ridden')} from activities)`,
    ].filter(Boolean);
    setStatus(
      `${inside.length} segments within ${settings.radiusKm} km: ${done} done, ${inside.length - done} not yet. ` +
        (parts.length ? `${parts.join(', ')}.` : 'Nothing new.') +
        (mapSearch || ' To add more, star segments on Strava\'s map or plan routes through new roads, then update again.') +
        hiddenHint('any')
    );
  } catch (err) {
    await loadLibrary().catch(() => {});
    handleLoadError(err, updateNearHome);
  } finally {
    setBusy(false);
    render();
  }
}

function updateDiscoverButton() {
  const blocked = exploreBlocked();
  $('#explore-btn').textContent = blocked ? '🔍 Discover from my routes' : '🔍 Discover in view';
  $('#explore-btn').title = blocked
    ? 'Strava blocks map search for this API app, so this lists the segments along your saved Strava routes'
    : "Sweep the current map view for segments you haven't done yet";
  $('#discover-budget').classList.toggle('hidden', blocked);
}

// ---------- rendering ----------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

let selectedId = null;

function setMode(mode) {
  settings.mode = mode;
  $('#mode').value = mode;
}

function visibleRows() {
  fitModels();
  const all = [...store.summaries.keys()].map(analyze).filter((r) => !r.seg.hazardous && !r.seg.private);
  const modeOk = (r) => settings.mode === 'all' || (settings.mode === 'mine' ? r.pr != null || r.eff : r.pr == null && !r.eff);
  const sportOk = (r) => settings.sport === 'all' || r.seg.activity_type === settings.sport;
  const q = $('#search').value.trim().toLowerCase();
  const searchOk = (r) => !q || `${r.seg.name} ${r.seg.city || ''}`.toLowerCase().includes(q);
  const radiusOk = (r) => !settings.home || !settings.radiusKm || (r.homeKm != null && r.homeKm <= settings.radiusKm);
  const base = all.filter((r) => modeOk(r) && sportOk(r) && searchOk(r) && radiusOk(r));

  const counts = {};
  for (const chip of CHIPS) counts[chip.key] = base.filter((r) => !chip.statuses || chip.statuses.includes(r.status)).length;

  const chip = CHIPS.find((c) => c.key === settings.chip) || CHIPS[0];
  const rows = base.filter((r) => !chip.statuses || chip.statuses.includes(r.status));

  const { key, dir } = settings.sort;
  const val = {
    name: (r) => r.seg.name?.toLowerCase(),
    home: (r) => r.homeKm,
    distance: (r) => r.seg.distance,
    grade: (r) => r.seg.average_grade,
    athletes: (r) => r.athletes,
    kom: (r) => r.kom,
    target: (r) => r.target,
    speed: (r) => (r.target && r.seg.distance ? r.seg.distance / r.target : null), // m/s, so rides and runs sort together
    pr: (r) => r.pr ?? r.predicted,
    score: (r) => r.score,
  }[key];
  rows.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
  return { rows, counts };
}

function render() {
  const { rows, counts } = visibleRows();

  $('#status-chips').innerHTML = CHIPS.map((c) => {
    const color = c.statuses?.length === 1 ? STATUS[c.statuses[0]].color : null;
    return `<button class="chip ${settings.chip === c.key ? 'active' : ''}" data-chip="${c.key}">
      ${color ? `<span class="dot" style="background:${color}"></span>` : ''}${c.label}<span class="count">${counts[c.key]}</span>
    </button>`;
  }).join('');

  $('#home-col').classList.toggle('hidden', !settings.home);
  document.querySelectorAll('.seg-table th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === settings.sort.key);
    th.classList.toggle('asc', th.dataset.sort === settings.sort.key && settings.sort.dir === 1);
  });

  $('#seg-body').innerHTML = rows.map(rowHtml).join('');
  const empty = $('#empty');
  empty.classList.toggle('hidden', rows.length > 0);
  if (!rows.length) {
    const ridden = store.efforts.size;
    empty.innerHTML =
      settings.mode === 'discover' && !counts.all
        ? `<p><b>New to me</b> lists segments you have never done, and none have been discovered here yet.</p>
           ${
             exploreBlocked()
               ? `<p>Strava blocks map search for this app, so discovery uses the segments along your saved Strava routes.
                  Plan routes through areas you want to explore on <a href="https://www.strava.com/maps" target="_blank" rel="noopener">strava.com/maps</a>, then:</p>
                  <p><button class="btn primary" data-empty="discover">🔍 Discover from my routes</button></p>`
               : `<p>Pan and zoom the map to where you like to ride, then:</p>
                  <p><button class="btn primary" data-empty="discover">🔍 Discover in this map view</button></p>`
           }
           ${ridden ? `<p><button class="btn" data-empty="mine">Show my ${ridden} synced segments</button></p>` : ''}`
        : counts.all
          ? `<p>None of these ${counts.all} segments are in <b>${esc(CHIPS.find((c) => c.key === settings.chip)?.label)}</b>.</p>
             <p><button class="btn" data-empty="all">Show all ${counts.all}</button></p>`
          : store.summaries.size
          ? 'No segments match these filters.'
          : 'Hit <b>Sync</b> to scan your recent activities, then use <b>Discover in view</b> to find new ones.';
  }

  renderMap(rows);
  if (selectedId) renderDetail(selectedId);
}

function rowHtml(r) {
  const st = STATUS[r.status];
  const gapCell =
    r.status === 'free'
      ? `<span class="badge" style="background:${st.color}">FREE</span>`
      : r.status === 'top10'
        ? `<span class="badge" style="background:${st.color}">${r.eff?.bestRank ? `#${r.eff.bestRank}` : 'IN'}</span>`
        : r.gapPct != null
          ? `<span class="${r.predicted ? 'predicted' : ''}">${r.predicted ? '~' : ''}${fmtPct(r.gapPct)}<span class="gap-s">${r.gap > 0 ? '+' : ''}${Math.round(r.gap)}s</span></span>`
          : '-';
  const youCell = r.pr != null ? fmtTime(r.pr) : r.predicted != null ? `<span class="predicted" title="Predicted good-day time">~${fmtTime(r.predicted)}</span>` : '-';
  const icon = isRun(r.seg) ? '🏃' : '🚴';
  const target = r.targetSource === 'free' ? 'any' : `${r.targetSource === 'manual' ? '' : '~'}${fmtTime(r.target)}`;
  return `<tr data-id="${r.id}" class="${r.id === selectedId ? 'selected' : ''}">
    <td><div class="seg-name"><span class="bar" style="background:${st.color}"></span>
      <div><div class="title">${icon} ${esc(r.seg.name)}</div><div class="sub">${esc(r.seg.city || '')}${r.eff ? ` · ${r.eff.count}× ${isRun(r.seg) ? 'run' : 'ridden'}` : ''}</div></div></div></td>
    ${settings.home ? `<td class="num">${r.homeKm != null ? `${r.homeKm.toFixed(1)} km` : '-'}</td>` : ''}
    <td class="num">${fmtDist(r.seg.distance)}</td>
    <td class="num">${r.seg.average_grade != null ? `${r.seg.average_grade.toFixed(1)}%` : '-'}</td>
    <td class="num">${fmtInt(r.athletes)}</td>
    <td class="num">${fmtTime(r.kom)}</td>
    <td class="num">${r.det ? target : '…'}</td>
    <td class="num">${r.target ? fmtPace(r.seg, r.target).replace(' /km', '/km') : r.targetSource === 'free' ? 'any' : '-'}</td>
    <td class="num">${youCell}</td>
    <td class="num">${gapCell}</td>
  </tr>`;
}

function renderDetail(id) {
  const r = analyze(id);
  const el = $('#detail');
  if (!r.seg) return el.classList.add('hidden');
  const st = STATUS[r.status];
  const boardName = { kom: 'KOM', qom: 'QOM', overall: 'Overall best' }[r.board];
  const targetLabel = { manual: 'Actual 10th (yours)', estimate: 'Estimated 10th', free: '10th place' }[r.targetSource] || '10th place';
  const sources = [...(store.sources.get(id) || [])].join(', ');

  let verdict = st.hint;
  if (r.predicted != null && r.gap != null)
    verdict =
      r.gap > 0
        ? `Never done it. On a good day you'd do about <b>${fmtTime(r.predicted)}</b>, ${Math.round(r.gap)} s (${fmtPct(r.gapPct)}) off the 10th place.`
        : `Never done it. A good-day effort (~${fmtTime(r.predicted)}) should beat the 10th place by about <b>${Math.round(-r.gap)} s</b>.`;
  else if (r.gap != null && r.gap > 0) verdict = `You need to find <b>${Math.round(r.gap)} s</b> (${fmtPct(r.gapPct)}) on your PR.`;
  else if (r.gap != null) verdict = `Your PR is already ${Math.round(-r.gap)} s faster than the ${r.targetSource === 'manual' ? 'entered' : 'estimated'} 10th place. Check the leaderboard - you may already be in.`;
  else if (r.status === 'unridden' && r.target)
    verdict = `Never done it. Average <b>${fmtPace(r.seg, r.target)}</b> to get in.<br><span class="hint">${noPredictionReason(r.seg)}</span>`;

  el.innerHTML = `
    <button class="close" title="Close">✕</button>
    <h3>${isRun(r.seg) ? '🏃' : '🚴'} ${esc(r.seg.name)}</h3>
    <div class="sub">${esc([r.seg.city, r.det?.state, r.seg.country].filter(Boolean).join(', '))} · from ${esc(sources)}</div>
    <div class="verdict" style="border-color:${st.color}"><b style="color:${st.color}">${st.label}</b><br>${verdict}</div>
    <dl>
      <dt>Distance</dt><dd>${fmtDist(r.seg.distance)}</dd>
      <dt>Grade (avg / max)</dt><dd>${r.seg.average_grade?.toFixed(1) ?? '-'}% / ${r.det?.maximum_grade?.toFixed(1) ?? '-'}%</dd>
      <dt>Elevation gain</dt><dd>${r.det?.total_elevation_gain != null ? `${Math.round(r.det.total_elevation_gain)} m` : '-'}</dd>
      <dt>Athletes / efforts</dt><dd>${fmtInt(r.athletes)} / ${fmtInt(r.det?.effort_count)}</dd>
      <dt>Est. ${r.board.toUpperCase()} field</dt><dd>${fmtInt(r.field)}</dd>
      <dt>${boardName}</dt><dd>${fmtTime(r.kom)} <span class="hint">${fmtPace(r.seg, r.kom)}</span></dd>
      <dt>${targetLabel}</dt><dd>${r.targetSource === 'free' ? 'any finish' : `${fmtTime(r.target)} <span class="hint">${fmtPace(r.seg, r.target)}</span>`}</dd>
      ${
        r.predicted != null
          ? `<dt>You (predicted)</dt><dd>~${fmtTime(r.predicted)} <span class="hint">${fmtPace(r.seg, r.predicted)}</span></dd>`
          : `<dt>Your PR</dt><dd>${fmtTime(r.pr)} <span class="hint">${fmtPace(r.seg, r.pr)}</span></dd>`
      }
      <dt>Your efforts (scanned)</dt><dd>${r.eff?.count ?? 0}${r.eff?.bestRank ? ` · best rank #${r.eff.bestRank}` : ''}</dd>
      ${r.det?.local_legend ? `<dt>Local Legend</dt><dd>${esc(r.det.local_legend.title)} <span class="hint">${esc(r.det.local_legend.effort_description || '')}</span></dd>` : ''}
    </dl>
    <div class="override">
      <label for="override-input">Actual 10th place</label>
      <input id="override-input" placeholder="m:ss" value="${settings.overrides[id] ? fmtTime(settings.overrides[id]) : ''}" />
      <button class="btn" id="override-save">Save</button>
      ${settings.overrides[id] ? '<button class="btn" id="override-clear">Clear</button>' : ''}
    </div>
    <p class="hint">Open the <a href="https://www.strava.com/segments/${id}" target="_blank" rel="noopener">segment on Strava</a>, read the 10th-place time off the leaderboard and enter it here for an exact gap.</p>
  `;
  el.classList.remove('hidden');
}

function select(id, pan = true) {
  selectedId = id;
  render();
  const layer = mapLayers.get(id);
  if (layer) showOnMap(layer, !pan);
  // Picked on the map: bring its row into view in the list.
  if (!pan) document.querySelector(`#seg-body tr[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Zoom to a segment while keeping it clear of the detail panel, which sits over the map's
// bottom-right corner (or its whole bottom on narrow screens).
function showOnMap(layer, onlyIfHidden) {
  const bounds = layer.getBounds ? layer.getBounds() : L.latLngBounds([layer.getLatLng()]);
  const mapBox = map.getContainer().getBoundingClientRect();
  const panel = $('#detail');
  const panelBox = panel.classList.contains('hidden') ? null : panel.getBoundingClientRect();

  if (onlyIfHidden) {
    if (!panelBox) return;
    const nw = map.latLngToContainerPoint(bounds.getNorthWest());
    const se = map.latLngToContainerPoint(bounds.getSouthEast());
    const left = panelBox.left - mapBox.left;
    const top = panelBox.top - mapBox.top;
    const covered = se.x > left && nw.x < left + panelBox.width && se.y > top && nw.y < top + panelBox.height;
    if (!covered) return;
  }

  const pad = 40;
  let bottomRight = [pad, pad];
  if (panelBox) {
    bottomRight =
      mapBox.width - panelBox.width > 220
        ? [mapBox.right - panelBox.left + pad, pad] // room to the left of the panel
        : [pad, Math.min(mapBox.bottom - panelBox.top + pad, mapBox.height * 0.6)]; // room above it
  }
  map.fitBounds(bounds, { maxZoom: 15, paddingTopLeft: [pad, pad], paddingBottomRight: bottomRight });
}

// ---------- map ----------

let map = null;
let segLayer = null;
const mapLayers = new Map();
let mapFitted = false;

function initMap() {
  const view = settings.mapView;
  map = L.map('map', { zoomControl: true }).setView(view ? view.center : [30, 0], view ? view.zoom : 2);
  map.on('moveend', () => {
    if (!mapFitted && !settings.mapView) return; // ignore the initial world view
    const c = map.getCenter();
    settings.mapView = { center: [c.lat, c.lng], zoom: map.getZoom() };
    saveSettings();
  });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  segLayer = L.featureGroup().addTo(map);
  homeLayer = L.featureGroup().addTo(map);
}

// ---------- home ----------

let homeLayer = null;

function updateHome() {
  const home = settings.home;
  $('#home-btn').textContent = home ? '🏠 Move home' : '🏠 Set home';
  $('#radius').classList.toggle('hidden', !home);
  $('#update-btn').classList.toggle('hidden', !home || !settings.radiusKm);
  $('#update-btn').textContent = '🔄 Update near home';
  $('#radius').value = String(settings.radiusKm);
  if (!homeLayer) return;
  homeLayer.clearLayers();
  if (!home) return;
  L.circleMarker(home, { radius: 7, color: '#fff', weight: 2, fillColor: '#fc4c02', fillOpacity: 1 }).bindTooltip('Home').addTo(homeLayer);
  if (settings.radiusKm) {
    L.circle(home, { radius: settings.radiusKm * 1000, color: '#fc4c02', weight: 1.5, dashArray: '6 6', fill: false, interactive: false }).addTo(homeLayer);
  }
}

function fitHome() {
  if (!settings.home) return;
  const km = settings.radiusKm || 20;
  map.fitBounds(L.latLng(settings.home).toBounds(km * 2000), { padding: [20, 20] });
}

function pickHome() {
  const container = map.getContainer();
  container.classList.add('picking');
  setStatus('Click your home on the map (Esc to cancel).');
  const done = () => {
    container.classList.remove('picking');
    map.off('click', onClick);
    document.removeEventListener('keydown', onKey);
  };
  const onClick = (e) => {
    done();
    settings.home = [+e.latlng.lat.toFixed(4), +e.latlng.lng.toFixed(4)];
    if (!settings.radiusKm) settings.radiusKm = 20;
    saveSettings();
    updateHome();
    fitHome();
    setStatus(`Home set. Showing segments within ${settings.radiusKm} km.`);
    render();
    loadForView();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    done();
    setStatus('');
  };
  map.on('click', onClick);
  document.addEventListener('keydown', onKey);
}

function decodePolyline(str) {
  const pts = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let result = 0;
      let byte;
      do {
        byte = str.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

function renderMap(rows) {
  if (!map) return;
  segLayer.clearLayers();
  mapLayers.clear();
  // Draw selected last so it sits on top.
  const ordered = [...rows].sort((a, b) => (a.id === selectedId) - (b.id === selectedId));
  for (const r of ordered) {
    const color = STATUS[r.status].color;
    const selected = r.id === selectedId;
    let layer;
    if (r.det?.polyline) {
      const pts = decodePolyline(r.det.polyline);
      layer = selected
        ? L.featureGroup([
            L.polyline(pts, { color: '#fff', weight: 12, opacity: 0.95 }), // halo
            L.polyline(pts, { color, weight: 6, opacity: 1 }),
            L.circleMarker(pts[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#22c55e', fillOpacity: 1 }).bindTooltip('Start'),
            L.circleMarker(pts[pts.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#111', fillOpacity: 1 }).bindTooltip('Finish'),
          ])
        : L.polyline(pts, { color, weight: 4, opacity: 0.85 });
    } else if (r.seg.start_latlng?.length === 2) {
      layer = selected
        ? L.circleMarker(r.seg.start_latlng, { radius: 10, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 })
        : L.circleMarker(r.seg.start_latlng, { radius: 5, color, fillOpacity: 0.8 });
    } else continue;
    layer.bindTooltip(`${esc(r.seg.name)}<br>${STATUS[r.status].label}${r.gapPct != null ? ` · ${fmtPct(r.gapPct)}` : ''}`, { sticky: true });
    layer.on('click', () => select(r.id, false));
    layer.addTo(segLayer);
    mapLayers.set(r.id, layer);
  }
}

// Centre the map on where you ride, unless a view was remembered from last time.
function fitMapOnce() {
  if (mapFitted || !map || settings.mapView) return;
  const starts = [...store.efforts.keys()].map((id) => store.summaries.get(id)?.start_latlng).filter((ll) => ll?.length === 2);
  if (!starts.length) return;
  mapFitted = true;
  map.fitBounds(L.latLngBounds(starts), { padding: [30, 30], maxZoom: 13 });
}

// ---------- header bits ----------

function showRate(rate) {
  if (!rate?.short) return;
  $('#rate').textContent = `API ${rate.short.used}/${rate.short.limit} · ${rate.daily.used}/${rate.daily.limit}`;
}

function showConnect(configured = true) {
  $('#app').classList.add('hidden');
  $('#connect').classList.remove('hidden');
  $('#setup-missing').classList.toggle('hidden', configured);
  $('#connect-btn').classList.toggle('hidden', !configured);
}

// ---------- events ----------

function bindEvents() {
  $('#sync-btn').addEventListener('click', sync);
  $('#explore-btn').addEventListener('click', exploreArea);

  $('#scan-count').value = String(settings.scanCount);
  $('#scan-count').addEventListener('change', (e) => {
    settings.scanCount = Number(e.target.value);
    saveSettings();
  });

  $('#home-btn').addEventListener('click', pickHome);
  $('#update-btn').addEventListener('click', updateNearHome);
  $('#radius').addEventListener('change', (e) => {
    settings.radiusKm = Number(e.target.value);
    saveSettings();
    updateHome();
    if (settings.radiusKm) fitHome();
    render();
    loadForView(); // a wider radius may show segments without details yet
  });

  $('#mode').value = settings.mode;
  $('#mode').addEventListener('change', (e) => {
    settings.mode = e.target.value;
    saveSettings();
    render();
    loadForView();
  });

  $('#discover-budget').value = String(settings.discoverBudget);
  $('#discover-budget').addEventListener('change', (e) => {
    settings.discoverBudget = Number(e.target.value);
    saveSettings();
  });

  $('#sport-filter').value = settings.sport;
  $('#sport-filter').addEventListener('change', (e) => {
    settings.sport = e.target.value;
    saveSettings();
    render();
  });

  $('#compare-to').value = settings.compareTo;
  $('#compare-to').addEventListener('change', (e) => {
    settings.compareTo = e.target.value;
    saveSettings();
    render();
  });

  const sigma = $('#sigma');
  sigma.value = settings.sigma;
  $('#sigma-val').textContent = settings.sigma.toFixed(2);
  sigma.addEventListener('input', (e) => {
    settings.sigma = Number(e.target.value);
    $('#sigma-val').textContent = settings.sigma.toFixed(2);
    saveSettings();
    scheduleRender();
  });

  $('#search').addEventListener('input', scheduleRender);

  $('#empty').addEventListener('click', (e) => {
    const action = e.target.closest('[data-empty]')?.dataset.empty;
    if (action === 'discover') exploreArea();
    if (action === 'mine') setMode('mine');
    if (action === 'all') settings.chip = 'all';
    if (action === 'mine' || action === 'all') {
      saveSettings();
      render();
    }
    if (action === 'mine') loadForView();
  });

  $('#status-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chip]');
    if (!chip) return;
    settings.chip = chip.dataset.chip;
    saveSettings();
    render();
  });

  document.querySelector('.seg-table thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    settings.sort = { key, dir: settings.sort.key === key ? -settings.sort.dir : 1 };
    saveSettings();
    render();
  });

  $('#seg-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) select(Number(tr.dataset.id));
  });

  $('#detail').addEventListener('click', (e) => {
    if (e.target.closest('.close')) {
      selectedId = null;
      $('#detail').classList.add('hidden');
      render();
    } else if (e.target.id === 'override-save') {
      const secs = parseTime($('#override-input').value);
      if (secs) settings.overrides[selectedId] = secs;
      else delete settings.overrides[selectedId];
      saveSettings();
      render();
    } else if (e.target.id === 'override-clear') {
      delete settings.overrides[selectedId];
      saveSettings();
      render();
    }
  });

  $('#detail').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'override-input') $('#override-save').click();
  });
}

// ---------- boot ----------

async function boot() {
  const { data: status } = await api('/api/status');
  if (!status.configured) return showConnect(false);
  if (!status.connected) return showConnect(true);

  try {
    store.athlete = (await api('/api/me')).data;
  } catch {
    return; // api() already switched to the connect screen on 401
  }

  $('#connect').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#athlete-name').textContent = `${store.athlete.firstname} ${store.athlete.lastname}`;
  if (store.athlete.profile?.startsWith('http')) $('#avatar').src = store.athlete.profile;
  else $('#avatar').classList.add('hidden');

  initMap();
  bindEvents();
  updateDiscoverButton();
  updateHome();
  // Everything known is in the server's database, so the list appears without any Strava request.
  // Sync only checks for new activities.
  await migrateBrowserSegments().catch((err) => console.warn('Migrating discovered segments failed', err));
  await loadLibrary();
  fitMapOnce();
  render();
  setStatus(`${store.summaries.size} segments in your library. Sync to check for new activities.`);
  loadForView();
}

boot().catch((err) => {
  document.body.innerHTML = `<p style="padding:24px">Failed to start: ${esc(err.message)}. Is the server running?</p>`;
});
