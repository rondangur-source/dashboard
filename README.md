# Team Dashboard

A modern, dark-themed team dashboard with a dedicated Bearded Trader view.

## Pages

| Page | File | Description |
|------|------|-------------|
| Team Dashboard | `index.html` | Calendar, tasks, team stats |
| Bearded Trader | `bearded-trader.html` | Live trading dashboard, active trades, PnL |
| Trade History | `trades.html` | Full trade history with filters |

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  MSS Trader     │────▶│  sync-dashboard   │────▶│  Dashboard  │
│  (logs/virt-     │     │  (Node.js script)│     │  (Vercel/   │
│   trades.json)   │     │  runs every 30s   │     │   Netlify)  │
└─────────────────┘     └──────────────────┘     └─────────────┘
                                                      │
                                                      ▼
                                              📊 Live Data
```

## Setup & Deployment

### Option 1: Vercel (Recommended)

1. **Create GitHub repo** and push these files:
   ```bash
   cd /data/.openclaw/workspace/dashboard-team
   git init
   git add .
   git commit -m "Initial dashboard"
   git remote add origin https://github.com/YOUR_USER/team-dashboard.git
   git push -u origin main
   ```

2. **Connect to Vercel:**
   - Go to [vercel.com](https://vercel.com)
   - "Import Project" → select your repo
   - Framework: "Static"
   - Deploy!

3. **Done!** Your dashboard is live at `https://your-project.vercel.app`

### Option 2: Netlify

1. Same as above, but import to [netlify.com](https://netlify.com)

### Option 3: Self-hosted (keep it private)

```bash
# On your VPS
cd /data/.openclaw/workspace/dashboard-team
npx serve .
```

## Data Sync

The dashboard reads from `data/dashboard-data.json`. To update this:

### Option A: Poll from browser
Add to each HTML page:
```javascript
async function loadDashboardData() {
    const res = await fetch('https://your-sync-endpoint.com/dashboard-data.json');
    const data = await res.json();
    updateUI(data);
}
setInterval(loadDashboardData, 30000);
```

### Option B: GitHub Gist (easiest for private)

1. Create a private Gist with API token
2. Modify `sync-dashboard.js` to push to Gist
3. Dashboard fetches from Gist URL

### Option C: Firebase Realtime DB (recommended for real-time)

1. Create Firebase project
2. Update `sync-dashboard.js` to push data
3. Dashboard listens to Firebase

## Cron Setup (for sync)

```bash
# Edit crontab
crontab -e

# Add this line (runs every minute)
* * * * * cd /data/.openclaw/workspace/dashboard-team && node scripts/sync-dashboard.js
```

## Customization

### Colors
Edit CSS variables in each file:
```css
:root {
    --bg-primary: #0a0a0f;
    --accent: #f7931a;  /* Bitcoin orange for trader page */
    --accent: #6c5ce7;  /* Purple for team page */
}
```

### Tasks/Calendar
Edit the hardcoded HTML in `index.html` or connect to a backend.

### Logo
Replace `TeamFlow` with your team name in the nav.

## Files

```
dashboard-team/
├── index.html           # Team dashboard page
├── bearded-trader.html  # Trading dashboard
├── trades.html          # Trade history
├── scripts/
│   └── sync-dashboard.js  # Data sync script
└── README.md            # This file
```

## Notes

- All pages are fully responsive
- Charts use Chart.js (CDN)
- Fonts use Google Fonts (Inter)
- No external dependencies required
- Works offline after first load (with cached data)