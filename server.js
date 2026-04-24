require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const fetch    = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors({ origin: (o, cb) => cb(null, true) }));
app.use(express.json());
app.use(express.static(__dirname));

process.on('unhandledRejection', (r) => console.error('[crash] unhandledRejection:', r));
process.on('uncaughtException',  (e) => console.error('[crash] uncaughtException:', e.message));

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const AUTH_URL      = 'https://account.groupcls.com/auth/realms/cls/protocol/openid-connect/token';
const API_BASE      = 'https://api.groupcls.com/telemetry/api/v1';
const CLIENT_ID     = 'api-telemetry';
const USERNAME      = process.env.CLS_USERNAME;
const PASSWORD      = process.env.CLS_PASSWORD;
const PORT          = parseInt(process.env.PORT) || 3001;
const CACHE_FILE    = path.join(__dirname, 'cache.json');
const POLL_INTERVAL = 60 * 60 * 1000; // 1 hour in ms
const BACKFILL_FROM = '2025-01-01T00:00:00.000Z'; // full history start

// ─────────────────────────────────────────────
// TOKEN MANAGER
// ─────────────────────────────────────────────
let tokenStore = { accessToken:null, refreshToken:null, expiresAt:0, refreshExpiresAt:0 };

async function getAccessToken() {
  const now = Date.now()/1000;
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
  if (!res.ok) throw new Error(`Refresh failed (${res.status})`);
  storeTokens(await res.json());
}

function storeTokens(data) {
  const now = Date.now()/1000;
  tokenStore.accessToken      = data.access_token;
  tokenStore.refreshToken     = data.refresh_token;
  tokenStore.expiresAt        = now + (data.expires_in || 300);
  tokenStore.refreshExpiresAt = now + (data.refresh_expires_in || 1800);
  console.log(`[auth] Token valid ${data.expires_in}s, refresh ${data.refresh_expires_in}s`);
}

// ─────────────────────────────────────────────
// CLS API HELPER
// ─────────────────────────────────────────────
async function clsPost(path, body) {
  const token = await getAccessToken();
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    console.log(`[api] POST ${path}`, JSON.stringify(body).slice(0,120));
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
      throw Object.assign(new Error(`HTTP ${res.status}: ${txt.slice(0,200)}`), { status: res.status });
    }
    console.log(`[api] → ${res.status}, items: ${data?.contents?.length ?? JSON.stringify(data).slice(0,80)}`);
    if (!res.ok) throw Object.assign(new Error(data.title || 'API error'), { status: res.status, data });
    return data;
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`Timeout: ${path}`);
    throw e;
  }
}

function parsePoints(contents) {
  return (contents || [])
    .filter(m => m.dopplerLocLat && m.dopplerLocLon)
    .map(m => ({
      lat:  m.dopplerLocLat,
      lon:  m.dopplerLocLon,
      alt:  m.dopplerLocAlt,
      err:  m.dopplerLocErrorRadius,
      cls:  m.dopplerLocClass,
      msgs: m.dopplerNbMsg,
      dt:   m.msgDatetime || m.dopplerDatetime,
      sat:  m.kineisMetadata?.sat,
    }))
    .sort((a, b) => a.dt.localeCompare(b.dt));
}

// ─────────────────────────────────────────────
// CACHE MANAGER
// ─────────────────────────────────────────────
// Cache structure:
// {
//   lastUpdated: ISO string,
//   checkpoint: number (for realtime polling),
//   devices: { [deviceUid]: { deviceRef, points: [...] } }
// }

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw  = fs.readFileSync(CACHE_FILE, 'utf8');
      const data = JSON.parse(raw);
      const pts  = Object.values(data.devices || {}).reduce((s, d) => s + (d.points?.length || 0), 0);
      console.log(`[cache] Loaded from disk: ${pts} total points, last updated ${data.lastUpdated}`);
      return data;
    }
  } catch(e) {
    console.warn('[cache] Could not read cache file:', e.message);
  }
  return { lastUpdated: null, checkpoint: 0, devices: {} };
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    const pts = Object.values(cache.devices).reduce((s, d) => s + (d.points?.length || 0), 0);
    console.log(`[cache] Saved to disk: ${pts} total points`);
  } catch(e) {
    console.error('[cache] Could not save cache:', e.message);
  }
}

let cache = loadCache();

// Merge new points into existing cache for a device (deduplicate by dt+lat+lon)
function mergePoints(existing, incoming) {
  const seen = new Set(existing.map(p => p.dt + '|' + p.lat + '|' + p.lon));
  const newPts = incoming.filter(p => !seen.has(p.dt + '|' + p.lat + '|' + p.lon));
  if (newPts.length > 0) {
    console.log(`[cache] +${newPts.length} new points`);
  }
  return [...existing, ...newPts].sort((a, b) => a.dt.localeCompare(b.dt));
}

// ─────────────────────────────────────────────
// BACKFILL — full history via retrieve-bulk
// Called once on startup if cache is empty
// ─────────────────────────────────────────────
async function runBackfill(devices) {
  console.log(`\n[backfill] Starting full history backfill for ${devices.length} devices…`);
  const to = new Date().toISOString();

  for (const dev of devices) {
    try {
      const data = await clsPost('/retrieve-bulk', {
        pagination:      { first: 5000 },
        retrieveDoppler: true, retrieveGpsLoc: true, retrieveMetadata: true,
        deviceUids:      [dev.deviceUid],
        fromDatetime:    BACKFILL_FROM,
        toDatetime:      to,
        datetimeFormat:  'DATETIME',
      });
      const points = parsePoints(data.contents);
      cache.devices[dev.deviceUid] = {
        deviceRef: dev.deviceRef,
        points,
      };
      console.log(`[backfill] ${dev.deviceRef}: ${points.length} points`);
    } catch(e) {
      console.error(`[backfill] ${dev.deviceRef} failed:`, e.message);
      if (!cache.devices[dev.deviceUid]) {
        cache.devices[dev.deviceUid] = { deviceRef: dev.deviceRef, points: [] };
      }
    }
    await new Promise(r => setTimeout(r, 800)); // be kind to the API
  }

  cache.lastUpdated  = new Date().toISOString();
  cache.checkpoint   = 0; // will be set on first realtime call
  saveCache(cache);
  console.log('[backfill] Complete.\n');
}

// ─────────────────────────────────────────────
// REALTIME POLL — incremental updates
// Called every hour after backfill
// ─────────────────────────────────────────────
async function runRealtimePoll() {
  console.log(`\n[poll] Polling for new data (checkpoint: ${cache.checkpoint})…`);
  try {
    const data = await clsPost('/retrieve-realtime', {
      checkpoint:      cache.checkpoint,
      retrieveDoppler: true, retrieveGpsLoc: true, retrieveMetadata: true,
      datetimeFormat:  'DATETIME',
    });

    // Update checkpoint for next poll
    if (data.checkpoint != null) {
      cache.checkpoint = data.checkpoint;
    }

    // Merge new points per device
    const newPoints = parsePoints(data.contents);
    if (newPoints.length === 0) {
      console.log('[poll] No new points.');
    } else {
      // Group by deviceUid
      const byDevice = {};
      for (const p of (data.contents || [])) {
        if (!p.dopplerLocLat || !p.dopplerLocLon) continue;
        const uid = p.deviceUid;
        if (!byDevice[uid]) byDevice[uid] = [];
        byDevice[uid].push({
          lat: p.dopplerLocLat, lon: p.dopplerLocLon, alt: p.dopplerLocAlt,
          err: p.dopplerLocErrorRadius, cls: p.dopplerLocClass, msgs: p.dopplerNbMsg,
          dt:  p.msgDatetime || p.dopplerDatetime, sat: p.kineisMetadata?.sat,
        });
      }

      let totalNew = 0;
      for (const [uid, pts] of Object.entries(byDevice)) {
        if (!cache.devices[uid]) cache.devices[uid] = { deviceRef: String(uid), points: [] };
        const before = cache.devices[uid].points.length;
        cache.devices[uid].points = mergePoints(cache.devices[uid].points, pts);
        totalNew += cache.devices[uid].points.length - before;
      }
      console.log(`[poll] Added ${totalNew} new points across ${Object.keys(byDevice).length} devices`);
    }

    cache.lastUpdated = new Date().toISOString();
    saveCache(cache);
  } catch(e) {
    console.error('[poll] Failed:', e.message);
    // If checkpoint too old (>6h), reset it
    if (e.message?.includes('429') || e.message?.includes('checkpoint')) {
      console.warn('[poll] Resetting checkpoint to 0');
      cache.checkpoint = 0;
    }
  }
  console.log(`[poll] Done. Next poll in ${POLL_INTERVAL/60000} minutes.\n`);
}

// ─────────────────────────────────────────────
// STARTUP SEQUENCE
// ─────────────────────────────────────────────
async function startup() {
  // 1. Auth
  await getAccessToken();
  console.log('✅ Auth OK');

  // 2. Get device list
  let devices;
  try {
    const devData = await clsPost('/retrieve-device-list', {});
    devices = devData.contents || [];
    console.log(`[startup] ${devices.length} devices found`);
  } catch(e) {
    console.error('[startup] Could not fetch device list:', e.message);
    return;
  }

  // 3. Backfill if cache is empty or very old
  const cacheIsEmpty = Object.keys(cache.devices).length === 0;
  const cacheAge = cache.lastUpdated
    ? (Date.now() - new Date(cache.lastUpdated).getTime()) / 3600000
    : Infinity;

  if (cacheIsEmpty) {
    console.log('[startup] Cache empty — running full backfill…');
    await runBackfill(devices);
  } else {
    console.log(`[startup] Cache exists (${cacheAge.toFixed(1)}h old) — skipping backfill`);
    // Run a quick realtime poll to catch up on missed time
    await runRealtimePoll();
  }

  // 4. Schedule hourly realtime polls
  setInterval(runRealtimePoll, POLL_INTERVAL);
  console.log(`[startup] Polling scheduled every ${POLL_INTERVAL/60000} minutes`);
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  const now = Date.now()/1000;
  const totalPoints = Object.values(cache.devices)
    .reduce((s, d) => s + (d.points?.length || 0), 0);
  res.json({
    status:         'ok',
    tokenValid:     now < tokenStore.expiresAt,
    tokenExpiresIn: Math.round(tokenStore.expiresAt - now),
    cacheLastUpdated: cache.lastUpdated,
    cacheAgeMinutes: cache.lastUpdated
      ? Math.round((Date.now() - new Date(cache.lastUpdated).getTime()) / 60000)
      : null,
    totalCachedPoints: totalPoints,
    checkpoint:     cache.checkpoint,
    user:           USERNAME,
  });
});

// Main track endpoint — served from cache
app.get('/api/tracks', (req, res) => {
  const { from, to } = req.query;

  const result = Object.entries(cache.devices).map(([uid, dev]) => {
    let pts = dev.points || [];

    // Filter by date range if provided
    if (from) pts = pts.filter(p => p.dt >= from);
    if (to)   pts = pts.filter(p => p.dt <= to);

    return { deviceUid: Number(uid), deviceRef: dev.deviceRef, points: pts };
  });

  res.json({
    devices:      result,
    fromCache:    true,
    lastUpdated:  cache.lastUpdated,
    cacheAgeMinutes: cache.lastUpdated
      ? Math.round((Date.now() - new Date(cache.lastUpdated).getTime()) / 60000)
      : null,
  });
});

// Single device track from cache
app.get('/api/track/:deviceUid', (req, res) => {
  const uid = Number(req.params.deviceUid);
  const { from, to } = req.query;
  const dev = cache.devices[uid];
  if (!dev) return res.status(404).json({ error: 'Device not found in cache' });

  let pts = dev.points || [];
  if (from) pts = pts.filter(p => p.dt >= from);
  if (to)   pts = pts.filter(p => p.dt <= to);

  res.json({ deviceUid: uid, deviceRef: dev.deviceRef, points: pts, fromCache: true });
});

// Force a manual cache refresh (admin use)
app.post('/api/refresh', async (req, res) => {
  res.json({ message: 'Refresh triggered in background' });
  try { await runRealtimePoll(); } catch(e) { console.error('[refresh]', e.message); }
});

// Cache status
app.get('/api/cache-status', (req, res) => {
  const summary = Object.entries(cache.devices).map(([uid, dev]) => ({
    deviceUid:   Number(uid),
    deviceRef:   dev.deviceRef,
    pointCount:  dev.points?.length || 0,
    firstPoint:  dev.points?.[0]?.dt || null,
    lastPoint:   dev.points?.[dev.points.length-1]?.dt || null,
  }));
  res.json({
    lastUpdated:  cache.lastUpdated,
    checkpoint:   cache.checkpoint,
    devices:      summary,
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
console.log(`[env] CLS_USERNAME: ${USERNAME || 'NOT SET'}`);
console.log(`[env] CLS_PASSWORD: ${PASSWORD ? '***set***' : 'NOT SET'}`);

if (!USERNAME || !PASSWORD) {
  console.error('❌  Missing CLS_USERNAME or CLS_PASSWORD — set them in Railway Variables tab');
  process.exit(1);
}

app.listen(PORT, async () => {
  console.log(`\n🐦  Bird Tracker backend running on PORT ${PORT}`);
  console.log(`    process.env.PORT = ${process.env.PORT}`);
  console.log(`    Open: /audubon-bird-tracker.html\n`);
  try { await startup(); }
  catch(e) { console.error('❌  Startup failed:', e.message); }
});
