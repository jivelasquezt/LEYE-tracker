# Lesser Yellowlegs Migration Tracker

Backend API proxy for the National Audubon Society bird tracking website.
Serves the frontend and handles authenticated calls to the CLS Telemetry API.

## Setup (local)

```bash
npm install
cp env .env          # then edit .env with your credentials
node server.js
```

Open http://localhost:3001/audubon-bird-tracker.html

## Environment variables

Set these in your hosting dashboard (Railway, Render, etc.) — never commit them:

| Variable | Description |
|---|---|
| `CLS_USERNAME` | Your CLS account email |
| `CLS_PASSWORD` | Your CLS account password |
| `PORT` | Port (set automatically by host) |

## Deploy to Railway

1. Push this repo to GitHub (`.env` is gitignored — credentials stay local)
2. Go to railway.app → New Project → Deploy from GitHub
3. Set `CLS_USERNAME` and `CLS_PASSWORD` in Railway's Variables tab
4. Copy the generated URL and open `<url>/audubon-bird-tracker.html`

## Attribution

Bird tracking data: CLS Group / Kinéis satellite network  
Lesser Yellowlegs illustration: SVG original  
Map tiles: © Esri  
