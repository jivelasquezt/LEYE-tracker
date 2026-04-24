require('dotenv').config({ path: '.env' }); // Railway injects vars directly; .env is local only
const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();

// Prevent unhandled rejections from crashing the process
process.on('unhandledRejection', (reason, promise) => {
  console.error('[crash] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[crash] Uncaught exception:', err.message);
});
app.use(cors({ origin: (o, cb) => cb(null, true) }));
app.use(express.json());
app.use(express.static(__dirname));

const AUTH_URL  = 'https://account.groupcls.com/auth/realms/cls/protocol/openid-connect/token';
const API_BASE  = 'https://api.groupcls.com/telemetry/api/v1';
const CLIENT_ID = 'api-telemetry';
const USERNAME  = process.env.CLS_USERNAME;
const PASSWORD  = process.env.CLS_PASSWORD;
const PORT      = process.env.PORT || 3001;

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
  let data; try { data = await res.json(); } catch(e) { const txt = await res.text().catch(()=>""); throw Object.assign(new Error(`HTTP ${res.status}: ${txt.slice(0,200)}`), {status:res.status}); }
  if (!res.ok) throw new Error(`Login failed (${res.status}): ${JSON.stringify(data)}`);
  storeTokens(data);
}

async function doRefresh() {
  const body = new URLSearchParams({ grant_type:'refresh_token', client_id:CLIENT_ID, refresh_token:tokenStore.refreshToken });
  const res  = await fetch(AUTH_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  if (!res.ok) throw new Error('Refresh failed');
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

async function clsPost(path, body) {
  const token = await getAccessToken();
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    console.log(`[api] POST ${path}`, JSON.stringify(body).slice(0,100));
    const res  = await fetch(`${API_BASE}${path}`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${token}`, 'User-Agent':'AudubonBirdTracker/1.0' },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    clearTimeout(timer);
    let data; try { data = await res.json(); } catch(e) { const txt = await res.text().catch(()=>""); throw Object.assign(new Error(`HTTP ${res.status}: ${txt.slice(0,200)}`), {status:res.status}); }
    console.log(`[api] → ${res.status}, items: ${data?.contents?.length ?? JSON.stringify(data).slice(0,60)}`);
    if (!res.ok) throw Object.assign(new Error(data.title||'API error'), { status:res.status, data });
    return data;
  } catch(e) {
    clearTimeout(timer);
    if (e.name==='AbortError') throw new Error(`Timeout: ${path}`);
    throw e;
  }
}

function parsePoints(contents) {
  return (contents||[])
    .filter(m => m.dopplerLocLat && m.dopplerLocLon)
    .map(m => ({ lat:m.dopplerLocLat, lon:m.dopplerLocLon, alt:m.dopplerLocAlt, err:m.dopplerLocErrorRadius,
                 cls:m.dopplerLocClass, msgs:m.dopplerNbMsg, dt:m.msgDatetime||m.dopplerDatetime, sat:m.kineisMetadata?.sat }))
    .sort((a,b) => a.dt.localeCompare(b.dt));
}

app.get('/health', (req,res) => {
  const now = Date.now()/1000;
  res.json({ status:'ok', tokenValid: now < tokenStore.expiresAt, tokenExpiresIn: Math.round(tokenStore.expiresAt-now), user:USERNAME });
});

app.get('/api/devices', async (req,res) => {
  try { res.json(await clsPost('/retrieve-device-list', {})); }
  catch(e) { console.error('[devices]',e.message); res.status(e.status||500).json({error:e.message}); }
});

app.get('/api/track/:deviceUid', async (req,res) => {
  const { from='2025-01-01T00:00:00.000Z', to=new Date().toISOString(), size=1000 } = req.query;
  try {
    const data = await clsPost('/retrieve-bulk', {
      pagination:{first:Number(size)}, retrieveDoppler:true, retrieveGpsLoc:true, retrieveMetadata:true,
      deviceUids:[Number(req.params.deviceUid)], fromDatetime:from, toDatetime:to, datetimeFormat:'DATETIME'
    });
    res.json({ deviceUid:Number(req.params.deviceUid), points:parsePoints(data.contents), hasMore:data.pageInfo?.hasNextPage });
  } catch(e) { console.error('[track]',e.message,e.data); res.status(e.status||500).json({error:e.message,detail:e.data}); }
});

app.get('/api/tracks', async (req,res) => {
  const { from='2025-01-01T00:00:00.000Z', to=new Date().toISOString(), size=1000 } = req.query;
  console.log(`\n[tracks] Loading all birds ${from} → ${to}`);
  let devices;
  try {
    devices = (await clsPost('/retrieve-device-list', {})).contents || [];
    console.log(`[tracks] ${devices.length} devices found`);
  } catch(e) { return res.status(500).json({error:'Device list failed: '+e.message}); }

  const tracks = [];
  for (const dev of devices) {
    try {
      const data = await clsPost('/retrieve-bulk', {
        pagination:{first:Number(size)}, retrieveDoppler:true, retrieveGpsLoc:true, retrieveMetadata:true,
        deviceUids:[dev.deviceUid], fromDatetime:from, toDatetime:to, datetimeFormat:'DATETIME'
      });
      const points = parsePoints(data.contents);
      console.log(`[tracks] ${dev.deviceRef}: ${points.length} pts`);
      tracks.push({ deviceUid:dev.deviceUid, deviceRef:dev.deviceRef, points });
    } catch(e) {
      console.error(`[tracks] ${dev.deviceRef} failed:`, e.message);
      tracks.push({ deviceUid:dev.deviceUid, deviceRef:dev.deviceRef, points:[], error:e.message });
    }
    await new Promise(r => setTimeout(r, 500)); // rate limit buffer
  }
  res.json({ devices: tracks });
});

console.log('[env] CLS_USERNAME:', USERNAME ? USERNAME : 'NOT SET');
console.log('[env] CLS_PASSWORD:', PASSWORD ? '***set***' : 'NOT SET');
if (!USERNAME || !PASSWORD) {
  console.error('❌  Missing CLS_USERNAME or CLS_PASSWORD — set them in Railway Variables tab');
  process.exit(1);
}

app.listen(PORT, async () => {
  console.log(`\n🐦  Bird Tracker backend → http://localhost:${PORT}`);
  console.log(`    Open: http://localhost:${PORT}/audubon-bird-tracker.html\n`);
  try { await getAccessToken(); console.log('✅  Auth OK\n'); }
  catch(e) { console.error('❌  Auth failed:', e.message); }
});
