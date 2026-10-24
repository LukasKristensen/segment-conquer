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
each new segment costs one request, so the first sync of a busy history may hit the limit. When that
happens the app stops, keeps everything loaded so far, and continues where it left off the next
time you sync.

Responses are cached in `data/cache/`:

- activity details forever
- segment details for 7 days
- the activity list for 10 minutes

Later syncs are close to free. The ⏏ button disconnects your account and clears the cache.
