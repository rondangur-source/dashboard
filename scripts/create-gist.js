#!/usr/bin/env node
const https = require('https');

const token = process.env.GITHUB_TOKEN || '';

const postData = JSON.stringify({
  description: 'MSS Trader Dashboard Data',
  public: false,
  files: {
    'dashboard-data.json': {
      content: JSON.stringify({
        timestamp: new Date().toISOString(),
        stats: { balance: 100, totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnL: 0 },
        activeTrades: [],
        recentTrades: [],
        tradingStatus: { isActive: true }
      })
    }
  }
});

const options = {
  hostname: 'api.github.com',
  path: '/gists',
  method: 'POST',
  headers: {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
    'User-Agent': 'TeamDashboard/1.0'
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    if (json.id) {
      console.log(`Gist created: ${json.id}`);
      console.log(`URL: ${json.html_url}`);
      console.log(`Raw: ${json.files['dashboard-data.json'].raw_url}`);
    } else {
      console.log('Error:', json.message);
    }
  });
});

req.write(postData);
req.end();