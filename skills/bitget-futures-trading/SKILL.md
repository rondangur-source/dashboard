---
name: bitget-futures-trading
description: Trade Bitget USDT-FUTURES using the MSS/BOS (Market Structure Shift) strategy. Trigger when user says to scan for trades, run the trading bot, execute trades, or check for Bitget signals. Also trigger for phrases like "clawbot trade", "scan pairs", "check for setups".
---

# Clawbot — Bitget Futures Trading (MSS/BOS Strategy)

Trade BTCUSDT, ETHUSDT, and BNBUSDT USDT-FUTURES on Bitget using the Market Structure Shift strategy. Risk 10% per trade, dynamic leverage capped at 25x, 1:1.5 RR.

## Prerequisites

Check that these environment variables are set. If any are missing, tell the user and stop:

```
BITGET_API_KEY
BITGET_API_SECRET
BITGET_PASSPHRASE
```

Optional:
```
BITGET_DEMO=true     # Use Bitget demo trading keys (virtual funds)
DRY_RUN=true         # Analyze only, never place orders
```

## Workflow

Make a todo list for all tasks and complete them in order.

### Step 1 — Write the trading script

Write the following complete Node.js script to `/tmp/bitget-trader.js`:

```javascript
#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = {
  apiKey:      process.env.BITGET_API_KEY,
  secret:      process.env.BITGET_API_SECRET,
  passphrase:  process.env.BITGET_PASSPHRASE,
  demo:        process.env.BITGET_DEMO === 'true',
  dryRun:      process.env.DRY_RUN === 'true',
  baseUrl:     'api.bitget.com',
  pairs:       ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'],
  productType: 'USDT-FUTURES',
  granularity: '1H',
  candleLimit: 100,
  maxLeverage: 25,
  riskPercent: 10,       // % of account risked per trade
  rrRatio:     1.5,      // take profit ratio
  swingLookback: 3,      // candles each side to confirm swing point
  zoneCandles:   8,      // candles before swing to define supply/demand zone
  maxSLPercent:  10,     // skip if SL is wider than this %
  minSLPercent:  0.05,   // skip if SL is tighter than this % (would cause huge leverage)
  logFile: '/data/.openclaw/workspace/logs/virtual-trades.json',
};

// ─── UTILS ───────────────────────────────────────────────────────────────────

function sign(timestamp, method, path, body = '') {
  const msg = `${timestamp}${method.toUpperCase()}${path}${body}`;
  return crypto.createHmac('sha256', CONFIG.secret).update(msg).digest('base64');
}

function apiRequest(method, endpoint, params = {}, body = null) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    let path = endpoint;

    if (method === 'GET' && Object.keys(params).length > 0) {
      const qs = new URLSearchParams(params).toString();
      path = `${endpoint}?${qs}`;
    }

    const bodyStr = body ? JSON.stringify(body) : '';
    const signature = sign(timestamp, method, path, bodyStr);

    const headers = {
      'ACCESS-KEY':        CONFIG.apiKey,
      'ACCESS-SIGN':       signature,
      'ACCESS-TIMESTAMP':  timestamp,
      'ACCESS-PASSPHRASE': CONFIG.passphrase,
      'Content-Type':      'application/json',
    };

    const options = {
      hostname: CONFIG.baseUrl,
      port: 443,
      path,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code !== '00000') {
            reject(new Error(`API error [${parsed.code}]: ${parsed.msg} | path: ${path}`));
          } else {
            resolve(parsed.data);
          }
        } catch (e) {
          reject(new Error(`Parse error: ${e.message} | raw: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── ACCOUNT ─────────────────────────────────────────────────────────────────

async function getBalance() {
  const data = await apiRequest('GET', '/api/v2/mix/account/account', {
    productType: CONFIG.productType,
    coin: 'USDT',
  });
  const available = parseFloat(data.available);
  if (isNaN(available)) throw new Error('Could not parse balance: ' + JSON.stringify(data));
  return available;
}

// ─── MARKET DATA ─────────────────────────────────────────────────────────────

// Returns candles oldest-first: [{ ts, open, high, low, close, vol }]
async function getCandles(symbol) {
  const raw = await apiRequest('GET', '/api/v2/mix/market/candles', {
    symbol,
    productType: CONFIG.productType,
    granularity: CONFIG.granularity,
    limit: String(CONFIG.candleLimit),
  });

  // Bitget returns newest-first; reverse to oldest-first
  return raw.reverse().map(c => ({
    ts:    parseInt(c[0]),
    open:  parseFloat(c[1]),
    high:  parseFloat(c[2]),
    low:   parseFloat(c[3]),
    close: parseFloat(c[4]),
    vol:   parseFloat(c[5]),
  }));
}

// ─── SWING POINT DETECTION ───────────────────────────────────────────────────

function detectSwings(candles) {
  const n = CONFIG.swingLookback;
  const highs = [];
  const lows  = [];

  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];

    // Swing high: highest in window
    let isHigh = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j !== i && candles[j].high >= c.high) { isHigh = false; break; }
    }
    if (isHigh) highs.push({ index: i, price: c.high, ts: c.ts });

    // Swing low: lowest in window
    let isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j !== i && candles[j].low <= c.low) { isLow = false; break; }
    }
    if (isLow) lows.push({ index: i, price: c.low, ts: c.ts });
  }

  return { highs, lows };
}

// ─── TREND DETECTION ─────────────────────────────────────────────────────────

// Returns 'uptrend', 'downtrend', or 'sideways'
function detectTrend(swings) {
  const { highs, lows } = swings;
  const recentHighs = highs.slice(-4);
  const recentLows  = lows.slice(-4);

  if (recentHighs.length < 2 || recentLows.length < 2) return 'sideways';

  const higherHighs = recentHighs.every((h, i) => i === 0 || h.price > recentHighs[i - 1].price);
  const higherLows  = recentLows.every((l, i)  => i === 0 || l.price > recentLows[i - 1].price);
  const lowerLows   = recentLows.every((l, i)  => i === 0 || l.price < recentLows[i - 1].price);
  const lowerHighs  = recentHighs.every((h, i) => i === 0 || h.price < recentHighs[i - 1].price);

  if (higherHighs && higherLows) return 'uptrend';
  if (lowerLows   && lowerHighs) return 'downtrend';
  return 'sideways';
}

// ─── BOS / MSS DETECTION ─────────────────────────────────────────────────────

// Returns { detected: bool, direction: 'bullish'|'bearish', bosIndex, keyLevel }
function detectBOS(candles, swings, trend) {
  const current = candles[candles.length - 1];
  const { highs, lows } = swings;

  if (trend === 'uptrend' && lows.length >= 2) {
    // Bearish BOS: price breaks below the second-to-last swing low (significant low before last HH)
    const sigLow = lows[lows.length - 2]; // the swing low before the most recent one
    if (current.close < sigLow.price) {
      return { detected: true, direction: 'bearish', bosIndex: candles.length - 1, keyLevel: sigLow.price };
    }
  }

  if (trend === 'downtrend' && highs.length >= 2) {
    // Bullish BOS: price breaks above the second-to-last swing high
    const sigHigh = highs[highs.length - 2];
    if (current.close > sigHigh.price) {
      return { detected: true, direction: 'bullish', bosIndex: candles.length - 1, keyLevel: sigHigh.price };
    }
  }

  return { detected: false };
}

// ─── SUPPLY / DEMAND ZONE ────────────────────────────────────────────────────

// Identifies the consolidation zone price retraces back into after BOS
function identifyZone(candles, swings, bosDirection) {
  const { highs, lows } = swings;

  let pivotIndex;
  if (bosDirection === 'bearish') {
    // Zone is around the last swing high (supply zone)
    const lastHigh = highs[highs.length - 1];
    if (!lastHigh) return null;
    pivotIndex = lastHigh.index;
  } else {
    // Zone is around the last swing low (demand zone)
    const lastLow = lows[lows.length - 1];
    if (!lastLow) return null;
    pivotIndex = lastLow.index;
  }

  // Take N candles around the pivot (before the pivot forming the base)
  const start = Math.max(0, pivotIndex - CONFIG.zoneCandles);
  const end   = pivotIndex;
  const zoneCandles = candles.slice(start, end + 1);

  if (zoneCandles.length === 0) return null;

  const zoneHigh = Math.max(...zoneCandles.map(c => c.high));
  const zoneLow  = Math.min(...zoneCandles.map(c => c.low));

  return { high: zoneHigh, low: zoneLow, pivotIndex };
}

// ─── PULLBACK CHECK ───────────────────────────────────────────────────────────

function inZone(price, zone) {
  return price >= zone.low && price <= zone.high;
}

// ─── REJECTION CHECK ─────────────────────────────────────────────────────────

function hasRejection(candles, direction) {
  const recent = candles.slice(-3); // last 3 candles
  if (direction === 'bearish') {
    // Look for upper wicks or weak bullish closes = sellers present
    return recent.some(c => {
      const range = c.high - c.low;
      if (range === 0) return false;
      const upperWick = c.high - Math.max(c.open, c.close);
      const body      = Math.abs(c.close - c.open);
      return (upperWick / range > 0.30) || (c.close > c.open && body / range < 0.30);
    });
  } else {
    // Look for lower wicks or weak bearish closes = buyers present
    return recent.some(c => {
      const range = c.high - c.low;
      if (range === 0) return false;
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const body      = Math.abs(c.close - c.open);
      return (lowerWick / range > 0.30) || (c.close < c.open && body / range < 0.30);
    });
  }
}

// ─── ENTRY TRIGGER ───────────────────────────────────────────────────────────

// Returns true if the last confirmed candle is a strong trigger candle
function hasEntryTrigger(candles, direction) {
  // Use second-to-last (fully closed) candle as trigger
  const trigger = candles[candles.length - 2];
  const range = trigger.high - trigger.low;
  if (range === 0) return false;
  const body = Math.abs(trigger.close - trigger.open);
  const bodyRatio = body / range;

  if (direction === 'bearish') {
    return trigger.close < trigger.open && bodyRatio > 0.40;
  } else {
    return trigger.close > trigger.open && bodyRatio > 0.40;
  }
}

// ─── RISK CALCULATION ────────────────────────────────────────────────────────

function calcRisk(entry, zone, direction, balance) {
  let sl, tp, slPct;

  if (direction === 'bearish') {
    sl = zone.high; // stop above supply zone
    slPct = (sl - entry) / entry * 100;
    tp = entry - (sl - entry) * CONFIG.rrRatio;
  } else {
    sl = zone.low;  // stop below demand zone
    slPct = (entry - sl) / entry * 100;
    tp = entry + (entry - sl) * CONFIG.rrRatio;
  }

  if (slPct <= 0) return null;
  if (slPct < CONFIG.minSLPercent) return { skip: true, reason: `SL too tight (${slPct.toFixed(3)}%)` };
  if (slPct > CONFIG.maxSLPercent) return { skip: true, reason: `SL too wide (${slPct.toFixed(2)}%)` };

  const rr = Math.abs(tp - entry) / Math.abs(sl - entry);
  if (rr < CONFIG.rrRatio) return { skip: true, reason: `RR too low (${rr.toFixed(2)})` };

  const leverage     = Math.min(Math.floor(CONFIG.riskPercent / slPct), CONFIG.maxLeverage);
  const riskAmount   = balance * (CONFIG.riskPercent / 100);
  const positionValue = riskAmount * leverage;
  const contractSize = positionValue / entry; // in base currency

  return { sl, tp, slPct, leverage, riskAmount, positionValue, contractSize, rr };
}

// ─── SET LEVERAGE ────────────────────────────────────────────────────────────

async function setLeverage(symbol, leverage) {
  await apiRequest('POST', '/api/v2/mix/account/set-leverage', {}, {
    symbol,
    productType: CONFIG.productType,
    marginCoin: 'USDT',
    leverage: String(leverage),
    holdSide: 'long_short',
  });
}

// ─── PLACE ORDER ────────────────────────────────────────────────────────────

async function placeOrder(symbol, direction, entry, sl, tp, contractSize, leverage) {
  const side = direction === 'bullish' ? 'buy' : 'sell';
  const size = contractSize.toFixed(4);

  const body = {
    symbol,
    productType:         CONFIG.productType,
    marginMode:          'crossed',
    marginCoin:          'USDT',
    size,
    side,
    tradeSide:           'open',
    orderType:           'market',
    presetStopLossPrice: String(sl.toFixed(4)),
    presetTakeProfitPrice: String(tp.toFixed(4)),
  };

  return await apiRequest('POST', '/api/v2/mix/order/place-order', {}, body);
}

// ─── LOG TRADE ───────────────────────────────────────────────────────────────

function logTrade(tradeData) {
  const logFile = CONFIG.logFile;
  const dir = path.dirname(logFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let existing = { balance: 0, trades: [] };
  if (fs.existsSync(logFile)) {
    try { existing = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch (_) {}
  }

  existing.trades.push(tradeData);
  existing.lastUpdated = new Date().toISOString();
  fs.writeFileSync(logFile, JSON.stringify(existing, null, 2));
}

// ─── ANALYSE PAIR ────────────────────────────────────────────────────────────

async function analysePair(symbol, balance) {
  console.log(`\n--- Scanning ${symbol} ---`);
  const candles = await getCandles(symbol);
  const current = candles[candles.length - 1];
  const entry   = current.close;

  console.log(`  Current price: ${entry}`);

  const swings = detectSwings(candles);
  const trend  = detectTrend(swings);
  console.log(`  Trend: ${trend} | Swing highs: ${swings.highs.length} | Swing lows: ${swings.lows.length}`);

  if (trend === 'sideways') {
    console.log(`  SKIP: no clear trend for MSS setup`);
    return { symbol, action: 'skip', reason: 'sideways market' };
  }

  const bos = detectBOS(candles, swings, trend);
  if (!bos.detected) {
    console.log(`  SKIP: no BOS/MSS detected yet`);
    return { symbol, action: 'skip', reason: 'no BOS detected' };
  }
  console.log(`  BOS detected: ${bos.direction} | key level: ${bos.keyLevel}`);

  const zone = identifyZone(candles, swings, bos.direction);
  if (!zone) {
    console.log(`  SKIP: could not identify supply/demand zone`);
    return { symbol, action: 'skip', reason: 'zone not identified' };
  }
  console.log(`  Zone: ${zone.low.toFixed(4)} — ${zone.high.toFixed(4)}`);

  if (!inZone(entry, zone)) {
    console.log(`  SKIP: price (${entry}) not in zone yet`);
    return { symbol, action: 'wait', reason: `waiting for pullback into zone ${zone.low.toFixed(4)}–${zone.high.toFixed(4)}` };
  }
  console.log(`  Price IS in zone`);

  if (!hasRejection(candles, bos.direction)) {
    console.log(`  SKIP: no rejection signal at zone`);
    return { symbol, action: 'wait', reason: 'waiting for rejection at zone' };
  }
  console.log(`  Rejection confirmed`);

  if (!hasEntryTrigger(candles, bos.direction)) {
    console.log(`  SKIP: no entry trigger candle`);
    return { symbol, action: 'wait', reason: 'waiting for trigger candle' };
  }
  console.log(`  Entry trigger confirmed`);

  const risk = calcRisk(entry, zone, bos.direction, balance);
  if (!risk || risk.skip) {
    console.log(`  SKIP: risk calc failed — ${risk?.reason || 'invalid SL'}`);
    return { symbol, action: 'skip', reason: risk?.reason || 'invalid SL' };
  }

  const direction = bos.direction === 'bearish' ? 'SHORT' : 'LONG';
  console.log(`  SIGNAL: ${direction} | Entry: ${entry} | SL: ${risk.sl.toFixed(4)} | TP: ${risk.tp.toFixed(4)}`);
  console.log(`  SL%: ${risk.slPct.toFixed(3)}% | Leverage: ${risk.leverage}x | Position: $${risk.positionValue.toFixed(2)} | Contracts: ${risk.contractSize.toFixed(4)}`);

  if (CONFIG.dryRun) {
    console.log(`  DRY RUN — order not placed`);
    return { symbol, action: 'signal', direction, entry, sl: risk.sl, tp: risk.tp, leverage: risk.leverage, dryRun: true };
  }

  try {
    await setLeverage(symbol, risk.leverage);
    const result = await placeOrder(symbol, bos.direction, entry, risk.sl, risk.tp, risk.contractSize, risk.leverage);
    console.log(`  ORDER PLACED: orderId ${result.orderId}`);

    const tradeLog = {
      id: result.orderId || `${symbol}-${Date.now()}`,
      pair: symbol,
      type: direction,
      entryPrice: entry,
      stopPrice: risk.sl,
      tpPrice: risk.tp,
      leverage: risk.leverage,
      contractSize: risk.contractSize.toFixed(4),
      positionValue: risk.positionValue.toFixed(2),
      riskAmount: risk.riskAmount.toFixed(2),
      slPct: risk.slPct.toFixed(3),
      rr: risk.rr.toFixed(2),
      outcome: null,
      pnlAmount: null,
      pnlPct: null,
      timestamp: new Date().toISOString(),
      demo: CONFIG.demo,
    };

    logTrade(tradeLog);
    return { symbol, action: 'traded', direction, orderId: result.orderId, ...tradeLog };
  } catch (err) {
    console.error(`  ORDER ERROR: ${err.message}`);
    return { symbol, action: 'error', reason: err.message };
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  if (!CONFIG.apiKey || !CONFIG.secret || !CONFIG.passphrase) {
    console.error('ERROR: Missing BITGET_API_KEY, BITGET_API_SECRET, or BITGET_PASSPHRASE');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`CLAWBOT — Bitget Futures MSS/BOS Scan`);
  console.log(`Mode: ${CONFIG.demo ? 'DEMO' : 'LIVE'} | Dry run: ${CONFIG.dryRun}`);
  console.log(`Pairs: ${CONFIG.pairs.join(', ')} | Timeframe: ${CONFIG.granularity}`);
  console.log(`Risk: ${CONFIG.riskPercent}% | Max leverage: ${CONFIG.maxLeverage}x | RR: 1:${CONFIG.rrRatio}`);
  console.log(`${'='.repeat(60)}`);

  const balance = await getBalance();
  console.log(`\nAccount balance (USDT): $${balance.toFixed(2)}`);

  const results = [];
  for (const pair of CONFIG.pairs) {
    try {
      const result = await analysePair(pair, balance);
      results.push(result);
    } catch (err) {
      console.error(`\nERROR scanning ${pair}: ${err.message}`);
      results.push({ symbol: pair, action: 'error', reason: err.message });
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('SCAN SUMMARY');
  console.log(`${'='.repeat(60)}`);
  for (const r of results) {
    const tag = r.action === 'traded' ? '>>> TRADE' : r.action === 'signal' ? '>>> SIGNAL' : r.action === 'wait' ? 'WAIT' : 'SKIP';
    console.log(`${r.symbol.padEnd(10)} ${tag.padEnd(12)} ${r.reason || (r.direction ? `${r.direction} entry` : '')}`);
  }

  // Output JSON for parsing
  console.log('\nRESULTS_JSON:' + JSON.stringify(results));
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
```

### Step 2 — Run the script

Execute:

```bash
BITGET_API_KEY="$BITGET_API_KEY" \
BITGET_API_SECRET="$BITGET_API_SECRET" \
BITGET_PASSPHRASE="$BITGET_PASSPHRASE" \
BITGET_DEMO="$BITGET_DEMO" \
DRY_RUN="${DRY_RUN:-false}" \
node /tmp/bitget-trader.js
```

If any environment variable is not set, ask the user to provide it before running.

### Step 3 — Parse and display results

Read the console output and present a clean summary:
- Show account balance
- For each pair: what was found (skip reason, wait reason, or trade details)
- If trades were placed: entry, SL, TP, leverage, position value
- If errors occurred: explain the error clearly

### Step 4 — Confirm log updated

If any trade was placed (not dry run), verify the log file was written:

```bash
cat /data/.openclaw/workspace/logs/virtual-trades.json | tail -c 1000
```

Report the trade count and latest entry.

---

## Strategy Reference

### Entry Conditions (both directions)
1. **MSS/BOS**: Prior trend confirmed (HH+HL for uptrend, LL+LH for downtrend), then price breaks a significant swing point
2. **Pullback**: Price retraces into the supply (short) or demand (long) zone
3. **Rejection**: Signs of reversal in the zone — wicks > 30% of range or weak body candles
4. **Trigger**: Last confirmed candle is a strong directional candle (body/range > 40%)

### Risk Rules
- Risk per trade: **10% of account**
- Leverage = `10 / SL_percent` capped at **25x**
- Take Profit = **1.5× the risk distance**
- Skip if SL% < 0.05% (leverage would exceed 200x)
- Skip if SL% > 10% (leverage would be below 1x)
- Skip if RR < 1.5

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BITGET_API_KEY` | Yes | Bitget API key |
| `BITGET_API_SECRET` | Yes | Bitget API secret |
| `BITGET_PASSPHRASE` | Yes | Bitget API passphrase |
| `BITGET_DEMO` | No | Set to `true` for demo account |
| `DRY_RUN` | No | Set to `true` to analyse only, no orders |

---

## Wrap Up

After completing the scan, summarize:

1. **Mode** — demo or live, dry run or real orders
2. **Balance** — current USDT available
3. **Signals found** — list any LONG/SHORT setups with full entry details
4. **Trades placed** — order IDs if real orders were submitted
5. **Skipped pairs** — brief reason per pair
6. **Next action** — e.g. "Re-run in 1 hour to check for pullback into zone"

If the user wants to set this up as an automated job, suggest:
```bash
# Add to crontab to scan every hour:
0 * * * * /path/to/run-clawbot.sh >> /data/.openclaw/workspace/logs/clawbot.log 2>&1
```
