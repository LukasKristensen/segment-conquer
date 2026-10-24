// Segment Conquer - persistent store.
// Every activity, effort and segment the app has ever seen lives here, so the segment list never
// depends on how many recent activities happen to be scanned or on what the browser remembers.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS activities (
      id         INTEGER PRIMARY KEY,
      start_date TEXT,
      data       TEXT NOT NULL            -- trimmed activity JSON
    );
    CREATE TABLE IF NOT EXISTS efforts (
      activity_id  INTEGER NOT NULL,
      segment_id   INTEGER NOT NULL,
      elapsed_time INTEGER NOT NULL,
      kom_rank     INTEGER,
      pr_rank      INTEGER,
      start_date   TEXT,
      PRIMARY KEY (activity_id, segment_id, start_date)
    );
    CREATE INDEX IF NOT EXISTS efforts_segment ON efforts (segment_id);
    CREATE TABLE IF NOT EXISTS segments (
      id                INTEGER PRIMARY KEY,
      summary           TEXT NOT NULL,    -- segment summary JSON
      detail            TEXT,             -- full detail JSON, null until fetched
      detail_fetched_at INTEGER,
      first_seen        INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS segment_sources (
      segment_id INTEGER NOT NULL,
      source     TEXT NOT NULL,           -- ridden | starred | explore | route
      PRIMARY KEY (segment_id, source)
    );
    -- Every entry of your Strava activity list (including manual ones without efforts), so a sync
    -- only has to ask for activities newer or older than what is already known.
    CREATE TABLE IF NOT EXISTS activity_index (
      id         INTEGER PRIMARY KEY,
      start_date TEXT NOT NULL,
      data       TEXT NOT NULL            -- list entry JSON
    );
    CREATE TABLE IF NOT EXISTS routes (
      id         TEXT PRIMARY KEY,        -- id_str: route ids overflow JS numbers
      updated_at TEXT,                    -- Strava's own change marker; unchanged means skip
      data       TEXT NOT NULL            -- { id, name, segments }
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const q = {
    getActivity: db.prepare('SELECT data FROM activities WHERE id = ?'),
    putActivity: db.prepare('INSERT OR REPLACE INTO activities (id, start_date, data) VALUES (?, ?, ?)'),
    putEffort: db.prepare(
      'INSERT OR REPLACE INTO efforts (activity_id, segment_id, elapsed_time, kom_rank, pr_rank, start_date) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    putSummary: db.prepare(
      `INSERT INTO segments (id, summary, first_seen) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET summary = excluded.summary`
    ),
    putSource: db.prepare('INSERT OR IGNORE INTO segment_sources (segment_id, source) VALUES (?, ?)'),
    getDetail: db.prepare('SELECT detail, detail_fetched_at FROM segments WHERE id = ?'),
    putDetail: db.prepare(
      `INSERT INTO segments (id, summary, detail, detail_fetched_at, first_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET detail = excluded.detail, detail_fetched_at = excluded.detail_fetched_at`
    ),
    allSegments: db.prepare(
      `SELECT s.id, s.summary, s.detail, s.detail_fetched_at, group_concat(src.source) AS sources
       FROM segments s LEFT JOIN segment_sources src ON src.segment_id = s.id
       GROUP BY s.id ORDER BY s.first_seen, s.id`
    ),
    effortStats: db.prepare(
      `SELECT segment_id, COUNT(*) AS count, MIN(elapsed_time) AS best, MIN(kom_rank) AS best_rank
       FROM efforts GROUP BY segment_id`
    ),
    counts: db.prepare(
      `SELECT (SELECT COUNT(*) FROM activities) AS activities, (SELECT COUNT(*) FROM segments) AS segments,
              (SELECT COUNT(*) FROM segments WHERE detail IS NOT NULL) AS details, (SELECT COUNT(*) FROM efforts) AS efforts`
    ),
    activityIds: db.prepare('SELECT id, start_date, data FROM activities ORDER BY start_date DESC'),
    putIndex: db.prepare('INSERT OR REPLACE INTO activity_index (id, start_date, data) VALUES (?, ?, ?)'),
    indexNewest: db.prepare('SELECT data FROM activity_index ORDER BY start_date DESC LIMIT ?'),
    indexBounds: db.prepare('SELECT COUNT(*) AS n, MIN(start_date) AS oldest, MAX(start_date) AS newest FROM activity_index'),
    getRoute: db.prepare('SELECT updated_at, data FROM routes WHERE id = ?'),
    putRoute: db.prepare('INSERT OR REPLACE INTO routes (id, updated_at, data) VALUES (?, ?, ?)'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    putMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  function addSegments(summaries, source) {
    const now = Date.now();
    for (const s of summaries) {
      if (!s?.id) continue;
      q.putSummary.run(s.id, JSON.stringify(s), now);
      q.putSource.run(s.id, source);
    }
  }

  const store = {
    getActivity(id) {
      const row = q.getActivity.get(id);
      return row ? JSON.parse(row.data) : null;
    },

    putActivity(act) {
      tx(() => {
        q.putActivity.run(act.id, act.start_date ?? null, JSON.stringify(act));
        for (const e of act.efforts) {
          q.putEffort.run(act.id, e.segment_id, e.elapsed_time, e.kom_rank ?? null, e.pr_rank ?? null, e.start_date ?? '');
        }
        addSegments(
          act.efforts.map((e) => e.segment),
          'ridden'
        );
      });
    },

    // Activities newest first, as list entries (for when the activity list itself can't be fetched).
    listActivities() {
      return q.activityIds.all().map((r) => {
        const a = JSON.parse(r.data);
        return { id: a.id, name: a.name, sport_type: a.sport_type, start_date: a.start_date };
      });
    },

    getDetail(id) {
      const row = q.getDetail.get(id);
      return row?.detail ? { data: JSON.parse(row.detail), fetchedAt: row.detail_fetched_at } : null;
    },

    putDetail(detail, fetchedAt = Date.now()) {
      q.putDetail.run(detail.id, JSON.stringify(detail), JSON.stringify(detail), fetchedAt, Date.now());
    },

    addSegments(summaries, source) {
      tx(() => addSegments(summaries, source));
    },

    // ---- activity list index ----
    putIndex(entries) {
      tx(() => {
        for (const a of entries) q.putIndex.run(a.id, a.start_date, JSON.stringify(a));
      });
    },
    indexNewest: (n) => q.indexNewest.all(n).map((r) => JSON.parse(r.data)),
    indexBounds: () => ({ ...q.indexBounds.get() }),

    // ---- routes ----
    getRoute(id) {
      const row = q.getRoute.get(id);
      return row ? { updatedAt: row.updated_at, data: JSON.parse(row.data) } : null;
    },
    putRoute(route, updatedAt) {
      q.putRoute.run(route.id, updatedAt ?? null, JSON.stringify(route));
    },

    getMeta: (key) => q.getMeta.get(key)?.value ?? null,
    putMeta: (key, value) => q.putMeta.run(key, String(value)),

    library() {
      const segments = q.allSegments.all().map((r) => ({
        summary: JSON.parse(r.summary),
        detail: r.detail ? JSON.parse(r.detail) : null,
        detailFetchedAt: r.detail_fetched_at,
        sources: r.sources ? r.sources.split(',') : [],
      }));
      const efforts = {};
      for (const r of q.effortStats.all()) efforts[r.segment_id] = { count: r.count, best: r.best, bestRank: r.best_rank };
      return { segments, efforts };
    },

    counts: () => ({ ...q.counts.get() }),
  };

  return store;
}

// One-time import of the old per-response JSON cache, so nothing loaded before the database existed is lost.
export function importJsonCache(store, cacheDir) {
  if (store.counts().activities || !fs.existsSync(cacheDir)) return null;
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));
    } catch {
      return null;
    }
  };
  const files = fs.readdirSync(cacheDir);
  let activities = 0;
  let details = 0;
  for (const f of files) {
    if (/^activity-\d+\.json$/.test(f)) {
      const entry = read(f);
      if (entry?.data?.efforts) {
        store.putActivity(entry.data);
        activities++;
      }
    } else if (/^segment-\d+\.json$/.test(f)) {
      const entry = read(f);
      if (entry?.data?.id) {
        store.putDetail(entry.data, entry.fetchedAt);
        details++;
      }
    } else if (/^route-\d+\.json$/.test(f)) {
      store.addSegments(read(f)?.data?.segments || [], 'route');
    } else if (/^explore-/.test(f)) {
      store.addSegments(read(f)?.data || [], 'explore');
    } else if (f === 'starred.json') {
      store.addSegments(read(f)?.data || [], 'starred');
    }
  }
  return { activities, details };
}
