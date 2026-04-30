require('dotenv').config({ override: false }); // Railway vars take priority over .env
const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const fetch    = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(cors({ origin: (o, cb) => cb(null, true) }));
app.use(express.json());
app.use(express.static(__dirname));

// ─────────────────────────────────────────────
// API KEY PROTECTION
// ─────────────────────────────────────────────
const API_KEY = process.env.API_KEY;

app.use('/api', (req, res, next) => {
  if (!API_KEY) return next(); // dev mode: no key required
  const provided = req.headers['x-api-key'] || req.query.apiKey;
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Serve tracker at root URL — better for social sharing
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/audubon-bird-tracker.html');
});

// Allow social media crawlers to access OG image and HTML
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'index, follow');
  // Allow iframe embedding and social crawlers
  res.removeHeader('X-Frame-Options');
  next();
});

// Explicitly serve preview image with correct headers for Facebook/Twitter
app.get('/preview.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(__dirname + '/preview.png');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[crash] unhandledRejection:', reason);
  console.error('[crash] Stack:', reason?.stack || 'no stack');
  // Don't exit — let Railway keep the process alive
});
process.on('uncaughtException',  e  => console.error('[crash] uncaughtException:', e.message));

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const AUTH_URL      = 'https://account.groupcls.com/auth/realms/cls/protocol/openid-connect/token';
const API_BASE      = 'https://api.groupcls.com/telemetry/api/v1';
const CLIENT_ID     = 'api-telemetry';
const USERNAME      = process.env.CLS_USERNAME;
const PASSWORD      = process.env.CLS_PASSWORD;
const PORT          = parseInt(process.env.PORT) || 3001;
const POLL_INTERVAL = 15 * 60 * 1000;   // 15 minutes
const BACKFILL_FROM = '2025-01-01T00:00:00.000Z';

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────
// Support both DATABASE_URL and individual PG* variables (Railway Postgres plugin)
const dbConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    }
  : {
      host:     process.env.PGHOST,
      port:     parseInt(process.env.PGPORT) || 5432,
      database: process.env.PGDATABASE,
      user:     process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl:      { rejectUnauthorized: false },
    };

console.log('[db] Connecting via:', process.env.DATABASE_URL ? 'DATABASE_URL' : 'PG* variables');
console.log('[db] Host:', dbConfig.host || '(from connection string)');

const db = new Pool(dbConfig);

// Prevent pool errors from crashing the process
db.on('error', (err) => {
  console.error('[db] Pool error (non-fatal):', err.message);
});

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS detections (
      device_uid   BIGINT       NOT NULL,
      device_ref   TEXT         NOT NULL,
      detected_at  TIMESTAMPTZ  NOT NULL,
      lat          DOUBLE PRECISION NOT NULL,
      lon          DOUBLE PRECISION NOT NULL,
      alt          REAL,
      error_m      REAL,
      loc_class    TEXT,
      n_messages   INTEGER,
      satellite    TEXT,
      PRIMARY KEY (device_uid, detected_at)
    );

    CREATE INDEX IF NOT EXISTS idx_detections_device_time
      ON detections (device_uid, detected_at DESC);

    CREATE TABLE IF NOT EXISTS poll_state (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      checkpoint  BIGINT  NOT NULL DEFAULT 0,
      last_poll   TIMESTAMPTZ,
      backfilled  BOOLEAN NOT NULL DEFAULT FALSE
    );

    INSERT INTO poll_state (id, checkpoint, backfilled)
    VALUES (1, 0, FALSE)
    ON CONFLICT (id) DO NOTHING;
  `);
  console.log('[db] Schema ready');
}

async function insertDetections(rows) {
  if (!rows.length) return 0;
  // Batch in chunks of 500 rows to stay under PostgreSQL's 65,535 param limit
  const CHUNK = 500;
  let totalInserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.map((r, j) => {
      const base = j * 9;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9})`;
    }).join(',');
    const params = chunk.flatMap(r => [
      r.device_uid, r.device_ref, r.detected_at,
      r.lat, r.lon, r.alt, r.error_m, r.loc_class, r.satellite,
    ]);
    const res = await db.query(`
      INSERT INTO detections
        (device_uid, device_ref, detected_at, lat, lon, alt, error_m, loc_class, satellite)
      VALUES ${values}
      ON CONFLICT (device_uid, detected_at) DO NOTHING
    `, params);
    totalInserted += res.rowCount;
  }
  return totalInserted;
}

async function getPollState() {
  const res = await db.query('SELECT * FROM poll_state WHERE id = 1');
  return res.rows[0];
}

async function setPollState(checkpoint, backfilled) {
  await db.query(`
    UPDATE poll_state
    SET checkpoint = $1, last_poll = NOW(), backfilled = $2
    WHERE id = 1
  `, [checkpoint, backfilled]);
}

// ─────────────────────────────────────────────
// TOKEN MANAGER
// ─────────────────────────────────────────────
let tokenStore = { accessToken: null, refreshToken: null, expiresAt: 0, refreshExpiresAt: 0 };

async function getAccessToken() {
  const now = Date.now() / 1000;
  if (tokenStore.accessToken && now < tokenStore.expiresAt - 30) return tokenStore.accessToken;
  if (tokenStore.refreshToken && now < tokenStore.refreshExpiresAt - 30) {
    try { await doRefresh(); return tokenStore.accessToken; } catch(e) { console.warn('[auth] refresh failed, re-login'); }
  }
  await doLogin();
  return tokenStore.accessToken;
}

async function doLogin() {
  console.log('[auth] Logging in…');
  const body = new URLSearchParams({ grant_type:'password', client_id:CLIENT_ID, username:USERNAME, password:PASSWORD, scope:'openid' });
  const res  = await fetch(AUTH_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  const data = await res.json();
  if (!res.ok) throw new Error(`Login failed (${res.status}): ${JSON.stringify(data)}`);
  storeTokens(data);
}

async function doRefresh() {
  const body = new URLSearchParams({ grant_type:'refresh_token', client_id:CLIENT_ID, refresh_token:tokenStore.refreshToken });
  const res  = await fetch(AUTH_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  if (!res.ok) throw new Error(`Refresh (${res.status})`);
  storeTokens(await res.json());
}

function storeTokens(d) {
  const now = Date.now() / 1000;
  tokenStore.accessToken      = d.access_token;
  tokenStore.refreshToken     = d.refresh_token;
  tokenStore.expiresAt        = now + (d.expires_in       || 300);
  tokenStore.refreshExpiresAt = now + (d.refresh_expires_in || 1800);
  console.log(`[auth] Token valid ${d.expires_in}s, refresh ${d.refresh_expires_in}s`);
}

// ─────────────────────────────────────────────
// CLS API HELPER
// ─────────────────────────────────────────────
async function clsPost(path, body) {
  const token = await getAccessToken();
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    console.log(`[api] POST ${path}`, JSON.stringify(body).slice(0, 100));
    const res  = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}`, 'User-Agent':'AudubonBirdTracker/1.0' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    let data;
    try { data = await res.json(); } catch(e) {
      const txt = await res.text().catch(() => '');
      throw Object.assign(new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`), { status: res.status });
    }
    console.log(`[api] → ${res.status}, items: ${data?.contents?.length ?? JSON.stringify(data).slice(0, 80)}`);
    if (!res.ok) throw Object.assign(new Error(data.title || 'API error'), { status: res.status, data });
    return data;
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`Timeout: ${path}`);
    throw e;
  }
}

function toRows(contents, deviceRef) {
  return (contents || [])
    .filter(m => m.dopplerLocLat && m.dopplerLocLon)
    .map(m => ({
      device_uid:  m.deviceUid,
      device_ref:  m.deviceRef || deviceRef || String(m.deviceUid),
      detected_at: m.msgDatetime || m.dopplerDatetime,
      lat:         m.dopplerLocLat,
      lon:         m.dopplerLocLon,
      alt:         m.dopplerLocAlt      ?? null,
      error_m:     m.dopplerLocErrorRadius ?? null,
      loc_class:   m.dopplerLocClass    ?? null,
      satellite:   m.kineisMetadata?.sat ?? null,
    }));
}

// ─────────────────────────────────────────────
// BACKFILL — full history, runs once on first deploy
// ─────────────────────────────────────────────
async function runBackfill(devices) {
  console.log(`\n[backfill] Starting full history for ${devices.length} devices from ${BACKFILL_FROM}…`);
  const to = new Date().toISOString();
  let totalInserted = 0;

  for (const dev of devices) {
    let first = 0;
    let pageNum = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        const data = await clsPost('/retrieve-bulk', {
          pagination:      { first: 5000, after: pageNum > 0 ? String(first - 1) : undefined },
          retrieveDoppler: true, retrieveGpsLoc: true, retrieveMetadata: true,
          deviceUids:      [dev.deviceUid],
          fromDatetime:    BACKFILL_FROM,
          toDatetime:      to,
          datetimeFormat:  'DATETIME',
        });

        const rows = toRows(data.contents, dev.deviceRef);
        const inserted = await insertDetections(rows);
        totalInserted += inserted;
        console.log(`[backfill] ${dev.deviceRef} page ${pageNum}: ${rows.length} pts, ${inserted} new`);

        hasMore = data.pageInfo?.hasNextPage && rows.length > 0;
        if (hasMore) {
          first += rows.length;
          pageNum++;
          await new Promise(r => setTimeout(r, 600));
        }
      } catch(e) {
        console.error(`[backfill] ${dev.deviceRef} failed:`, e.message);
        hasMore = false;
      }
    }
    await new Promise(r => setTimeout(r, 800));
  }

  await setPollState(0, true);
  console.log(`[backfill] Complete — ${totalInserted} new rows inserted.\n`);
}

// ─────────────────────────────────────────────
// REALTIME POLL — runs every 15 minutes
// ─────────────────────────────────────────────
let isPolling = false;

// Cached device list (refreshed every poll cycle to pick up new tags)
let cachedDevices = [];

async function refreshDeviceList() {
  try {
    const devData = await clsPost('/retrieve-device-list', {});
    cachedDevices = devData.contents || [];
    console.log(`[poll] device list refreshed: ${cachedDevices.length} devices`);
  } catch (e) {
    console.warn('[poll] device list refresh failed (using cache):', e.message);
  }
}

async function runRealtimePoll() {
  if (isPolling) { console.log('[poll] Already running, skipping.'); return; }
  isPolling = true;
  console.log('[poll] Starting poll...');

  const state = await getPollState();

  // Make sure we have a device list — needed for per-device queries
  if (!cachedDevices.length) await refreshDeviceList();
  if (!cachedDevices.length) {
    console.error('[poll] No devices known; aborting poll.');
    isPolling = false;
    return;
  }

  // Look back 30 min to comfortably cover the 15-min interval plus any drift.
  // ON CONFLICT DO NOTHING dedupes overlap with previous polls.
  const to   = new Date().toISOString();
  const from = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  console.log(`\n[poll] Polling ${cachedDevices.length} devices for window ${from} → ${to}`);

  let totalInserted = 0;
  let anyDeviceFailed = false;

  for (const dev of cachedDevices) {
    try {
      const data = await clsPost('/retrieve-bulk', {
        pagination:      { first: 5000 },
        retrieveDoppler: true, retrieveGpsLoc: true, retrieveMetadata: true,
        deviceUids:      [dev.deviceUid],
        fromDatetime:    from,
        toDatetime:      to,
        datetimeFormat:  'DATETIME',
      });
      const rows     = toRows(data.contents, dev.deviceRef);
      const inserted = await insertDetections(rows);
      totalInserted += inserted;
      console.log(`[poll] ${dev.deviceRef}: ${rows.length} pts, +${inserted} new`);
      // Small spacing between requests to be polite to the CLS API
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      anyDeviceFailed = true;
      console.error(`[poll] ${dev.deviceRef} failed:`, e.message);
      if (e.data) console.error('[poll] API error detail:', JSON.stringify(e.data).slice(0, 300));
    }
  }

  // last_poll bumps regardless so the UI reflects when we last *tried*
  await setPollState(state.checkpoint || 0, true);

  try {
    const total = await db.query('SELECT COUNT(*) FROM detections');
    console.log(`[poll] +${totalInserted} new rows | total: ${total.rows[0].count}${anyDeviceFailed ? ' (some devices failed)' : ''}`);
  } catch (e) {
    console.error('[poll] count query failed:', e.message);
  }

  isPolling = false;
  console.log(`[poll] Done. Next poll in ${POLL_INTERVAL / 60000} minutes.\n`);
}

// ─────────────────────────────────────────────
// STARTUP SEQUENCE
// ─────────────────────────────────────────────
async function startup() {
  await initDB();
  await getAccessToken();
  console.log('✅ Auth OK');

  // Get device list
  let devices;
  try {
    const devData = await clsPost('/retrieve-device-list', {});
    devices = devData.contents || [];
    cachedDevices = devices; // share with realtime poll
    console.log(`[startup] ${devices.length} devices found`);
  } catch(e) {
    console.error('[startup] Device list failed:', e.message);
    return;
  }

  const state = await getPollState();

  if (!state.backfilled) {
    console.log('[startup] First run — starting backfill…');
    // Run backfill in background, then start polling after it completes
    runBackfill(devices)
      .catch(e => console.error('[backfill error]', e.message))
      .finally(() => {
        setInterval(runRealtimePoll, POLL_INTERVAL);
        console.log(`[startup] Polling every ${POLL_INTERVAL / 60000} minutes\n`);
      });
  } else {
    console.log('[startup] DB already populated — running realtime poll…');
    await runRealtimePoll();
    // Only schedule interval AFTER startup poll completes
    setInterval(runRealtimePoll, POLL_INTERVAL);
    console.log(`[startup] Polling every ${POLL_INTERVAL / 60000} minutes\n`);
  }
}

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const state     = await getPollState();
    const countRes  = await db.query('SELECT COUNT(*) FROM detections');
    const devRes    = await db.query('SELECT device_uid, device_ref, COUNT(*) as pts, MAX(detected_at) as last_seen FROM detections GROUP BY device_uid, device_ref ORDER BY device_uid');
    const now       = Date.now() / 1000;

    res.json({
      status:            'ok',
      tokenValid:        now < tokenStore.expiresAt,
      tokenExpiresIn:    Math.round(tokenStore.expiresAt - now),
      lastPoll:          state.last_poll,
      pollAgeMinutes:    state.last_poll ? Math.round((Date.now() - new Date(state.last_poll).getTime()) / 60000) : null,
      backfilled:        state.backfilled,
      checkpoint:        state.checkpoint,
      totalDetections:   parseInt(countRes.rows[0].count),
      devices:           devRes.rows,
    });
  } catch(e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// Main tracks endpoint — fast SQL query with optional date filtering
app.get('/api/tracks', async (req, res) => {
  const { from, to } = req.query;

  try {
    let query = `
      SELECT
        device_uid, device_ref,
        detected_at AT TIME ZONE 'UTC' AS dt,
        lat, lon, alt, error_m AS err, loc_class AS cls, satellite AS sat
      FROM detections
      WHERE 1=1
    `;
    const params = [];

    if (from) { params.push(from); query += ` AND detected_at >= $${params.length}`; }
    if (to)   { params.push(to);   query += ` AND detected_at <= $${params.length}`; }

    query += ' ORDER BY device_uid, detected_at ASC';

    const result = await db.query(query, params);

    // Group by device
    const byDevice = {};
    for (const row of result.rows) {
      const uid = String(row.device_uid);
      if (!byDevice[uid]) byDevice[uid] = { deviceUid: row.device_uid, deviceRef: row.device_ref, points: [] };
      byDevice[uid].points.push({
        lat: parseFloat(row.lat),
        lon: parseFloat(row.lon),
        alt: row.alt ? parseFloat(row.alt) : null,
        err: row.err ? parseFloat(row.err) : null,
        cls: row.cls,
        sat: row.sat,
        dt:  row.dt instanceof Date ? row.dt.toISOString().replace('Z','') : row.dt,
      });
    }

    const state = await getPollState();
    const ageMin = state.last_poll ? Math.round((Date.now() - new Date(state.last_poll).getTime()) / 60000) : null;
    res.json({
      devices:          Object.values(byDevice),
      fromDB:           true,
      lastPoll:         state.last_poll,
      pollAgeMinutes:   ageMin,
      cacheAgeMinutes:  ageMin,  // frontend reads this name
    });
  } catch(e) {
    console.error('[/api/tracks]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per-device track
app.get('/api/track/:deviceUid', async (req, res) => {
  const { from, to } = req.query;
  const params = [req.params.deviceUid];
  let query = `
    SELECT detected_at AT TIME ZONE 'UTC' AS dt, lat, lon, alt, error_m AS err, loc_class AS cls, satellite AS sat
    FROM detections WHERE device_uid = $1
  `;
  if (from) { params.push(from); query += ` AND detected_at >= $${params.length}`; }
  if (to)   { params.push(to);   query += ` AND detected_at <= $${params.length}`; }
  query += ' ORDER BY detected_at ASC';

  try {
    const result = await db.query(query, params);
    res.json({ deviceUid: req.params.deviceUid, points: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Force immediate poll
app.post('/api/refresh', async (req, res) => {
  res.json({ message: 'Poll triggered' });
  runRealtimePoll().catch(e => console.error('[manual refresh]', e.message));
});

// DB stats
app.get('/api/db-status', async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT device_uid, device_ref,
        COUNT(*)                    AS total_points,
        MIN(detected_at)            AS first_detection,
        MAX(detected_at)            AS last_detection
      FROM detections
      GROUP BY device_uid, device_ref
      ORDER BY device_uid
    `);
    const state = await getPollState();
    res.json({ devices: rows.rows, pollState: state });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
console.log(`[env] CLS_USERNAME: ${USERNAME || 'NOT SET'}`);
console.log(`[env] CLS_PASSWORD: ${PASSWORD ? '***set***' : 'NOT SET'}`);
console.log(`[env] DATABASE_URL: ${process.env.DATABASE_URL ? '***set***' : 'NOT SET'}`);

if (!USERNAME || !PASSWORD) {
  console.error('❌  Missing CLS_USERNAME or CLS_PASSWORD');
  process.exit(1);
}
const hasPgConfig = process.env.DATABASE_URL || (process.env.PGHOST && process.env.PGDATABASE);
if (!hasPgConfig) {
  console.error('❌  Missing database config — need DATABASE_URL or PGHOST+PGDATABASE');
  console.error('    Available env vars:', Object.keys(process.env).filter(k => k.startsWith('PG') || k.includes('DATABASE')).join(', '));
  process.exit(1);
}

app.listen(PORT, async () => {
  console.log(`\n🐦  Bird Tracker backend on PORT ${PORT}\n`);
  try { await startup(); }
  catch(e) {
    console.error('❌  Startup error:', e.message);
    // Don't crash — keep serving cached data even if startup poll fails
  }
});
