# segment-conquer

Find the Strava segments where you can realistically get into the top 10.

Segment Conquer scans your recent activities (plus starred segments, plus any map area you explore),
looks up each segment's KOM/QOM time and how many athletes have done it, estimates the 10th-place
time and ranks the segments by how far your PR is from it. Easiest wins first:

| Status | Meaning |
| --- | --- |
| **Free top 10** | Fewer than 10 athletes on your leaderboard. Any finish gets you in. |
| **Within 5%** | Your PR is within 5% of the estimated 10th-place time. |
| **Within 15%** | A good day or a tailwind away. |
| **15%+ off** | Needs a lot more speed. |
| **Not ridden** | No effort yet. Shows the average speed or pace you'd need. |
| **Top 10** | Strava gave you a top-10 `kom_rank` on an effort (at upload time). |

Everything is shown in a sortable table and on a map, with segments colored by status.

### Segments near home

Click **🏠 Set home**, then click your home on the map. The list is filtered to segments starting
within the chosen radius (5 to 50 km, default 20), a **Home** column shows each segment's distance,
and segment details outside the radius aren't fetched. The home location is stored only in your
browser.

The filter covers every segment the app knows about: ridden, starred, discovered and on your routes.
If Strava blocks map search for your app, unknown segments near home won't appear until a route or
activity passes them.

**📡 Scan** finds and loads everything it can inside the radius:

1. When map search is available, it sweeps the whole circle, not just the map view, and skips map
   tiles outside it. If Strava refused map search before, it retries at most once a day.
2. Otherwise it reads your saved routes, re-reading only ones you've edited.
3. It then loads details for every known segment inside the radius, whichever mode is selected, and
   switches to **All segments**.

The status line then reports how many segments are in range, how many you've done, and where they
came from.

### Discovering new segments

The default view, **New to me**, shows segments you have never done. Pan the map to an area and
click **Discover in view**.

- Strava's explore API only returns the 10 most popular segments per area, and those have the most
  crowded leaderboards. So every area that comes back full is split into quarters and searched again.
- That digs down to the quiet segments, where a top-10 spot is easy.
- Each click spends at most the chosen number of Strava searches. Searches already cached are free,
  so clicking again digs deeper.

Strava refuses the explore endpoint for some API apps, even with a valid token. When that happens,
the button becomes **Discover from my routes** and lists every segment along your saved Strava routes.
To explore an area, plan a route through it in Strava's route builder (<https://www.strava.com/maps>)
and click Discover again.

On segments you haven't done, your time is predicted:

- A small model of your speed against grade and distance is fitted to your PRs (at least 10 per sport).
- It's set to a good day, your 75th-percentile effort.
- The predicted time is compared with the estimated 10th place, so new segments get a real gap and status.

## Setup

Requires Node.js 21 or newer. There are no npm dependencies.

1. Create an API application at <https://www.strava.com/settings/api>.
   Set **Authorization Callback Domain** to `localhost`.
2. Copy `.env.example` to `.env` and fill in `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`.
3. Start it:

   ```bash
   npm start
   ```

4. Open <http://localhost:3000>, click **Connect with Strava**, then **Sync**.

## How the 10th-place estimate works

Strava's API no longer exposes segment leaderboards, so the actual 10th-place time can't be fetched.
The app estimates it from what *is* available: the KOM/QOM time and the segment's athlete count.

Finish times are modeled as log-normal with spread σ (the **Spread** slider, default 0.10). Out of
*N* athletes, rank *k* sits near quantile (k - 0.5)/N, so

```
t10 ≈ KOM × exp(σ × (Φ⁻¹(9.5/N) − Φ⁻¹(0.5/N)))
```

Athlete counts aren't split by gender, so the KOM board assumes about 80% of athletes and the QOM
board about 20%. The leaderboard follows your Strava profile's sex by default and can be switched to
KOM, QOM or overall.

The estimate is rough. For segments you care about, open the segment on Strava, read the real
10th-place time, and enter it in the side panel. The app then uses your number instead of the estimate.

## Rate limits and caching

Strava allows about 100 read requests per 15 minutes and 1,000 per day. Each scanned activity and
each segment's details cost one request. To keep that low:

- Segment details are only loaded for segments the current view can show. **New to me** skips the
  segments you've ridden; switching to **My segments** loads them on demand. The speed model doesn't
  need details at all.
- The server stops 2 requests short of the limit instead of running into Strava's 429 lockout.
  The app then waits for the window to reset (the quarter hour, or midnight UTC for the daily limit)
  and continues automatically while the tab stays open.

## Data storage

Everything the app learns is stored in a local SQLite database, `data/segment-conquer.db`, using
Node's built-in `node:sqlite`:

| Table | Holds |
| --- | --- |
| `activities` | every activity fetched, with its segment efforts |
| `efforts` | one row per segment effort (time, KOM rank, PR rank) |
| `segments` | every segment ever seen: summary, full details and when they were fetched |
| `segment_sources` | where each segment came from: `ridden`, `starred`, `explore` or `route` |
| `activity_index` | every entry of your Strava activity list, including manual ones |
| `routes` | each saved route's segments, plus Strava's `updated_at` for it |

Nothing already stored is fetched again:

- The segment list loads from the database at startup without a single Strava request.
- **Sync** asks Strava only for activities newer than the newest one stored: one request, at most
  every 10 minutes. Older activities are fetched only while fewer than "Scan last *N*" are known.
  Segments from older activities always stay in the list.
- Activities are fetched once, ever.
- Routes are read once and again only when Strava's `updated_at` says you edited them.
- Segment details are fetched only for segments the current view shows (mode and home radius):
  missing ones first, then ones over 30 days old. When Strava is out of budget, the stored version is
  used.
- The route list and starred segments are cached as files in `data/cache/` for 30 minutes and
  6 hours.
- The ⏏ button disconnects your Strava account but keeps the database. Delete `data/` to start over.

On first start, the server imports the older per-file cache (`data/cache/activity-*.json`,
`segment-*.json`, `route-*.json`) into the database. Segments discovered by older versions, which
lived only in the browser, are handed over the next time the page loads.
