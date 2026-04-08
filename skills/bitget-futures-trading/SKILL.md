---
name: bitget-futures-trading
description: Trade Bitget USDT-FUTURES using the MSS/BOS (Market Structure Shift) strategy. Trigger when user says to scan for trades, run the trading bot, execute trades, or check for Bitget signals. Also trigger for phrases like "clawbot trade", "scan pairs", "check for setups".
---

# Clawbot — Bitget Futures Trading (MSS/BOS Strategy)

Trade BTCUSDT, ETHUSDT, and BNBUSDT on Bitget USDT-FUTURES. API credentials are built in. No env setup needed — just run.

## Optional overrides

```bash
DRY_RUN=true node /tmp/bitget-trader.js        # analyse only, no orders placed
BITGET_DEMO=true node /tmp/bitget-trader.js     # force demo/paper mode
```

## Workflow

Make a todo list and complete each step in order.

### Step 1 — Write the trading script

Write the following complete Node.js script to `/tmp/bitget-trader.js`:

```javascript
#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Credentials fall back to built-in values if env vars are not set.
// Override any value by exporting the matching env var before running.

const CONFIG = {
  apiKey:      process.env.BITGET_API_KEY    || 'bg_cba8086f33bf4d2d06628d73a2fbf2e3',
  secret:      process.env.BITGET_API_SECRET || 'd44494e8b7fa4c7f40ad55887b6ee96c07b23a3934e25213e97ab994c7f9c1ee',
  passphrase:  process.env.BITGET_PASSPHRASE || 'rondangur',
  demo:        process.env.BITGET_DEMO === 'true',   // default: false → LIVE trading
  dryRun:      process.env.DRY_RUN  === 'true',      // default: false → real orders
  baseUrl:     'api.bitget.com',
  pairs:       ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'],
  productType: 'USDT-FUTURES',
  granularity: '1H',
  candleLimit: 100,
  maxLeverage: 25,
  riskPercent: 10,
  rrRatio:     1.5,
  swingLookback: 3,
  zoneCandles:   8,
  maxSLPercent:  10,
  minSLPercent:  0.05,
  logFile: '/data/.openclaw/workspace/logs/virtual-trades.json',
};

const PAIR_CONFIG = {
  BTCUSDT: { minSize: 0.001, sizePrecision: 3 },
  ETHUSDT: { minSize: 0.01,  sizePrecision: 2 },
  BNBUSDT: { minSize: 0.1,   sizePrecision: 1 },
};

// ─── API AUTH & REQUEST ──────────────────────────────────────────────────────

function sign(timestamp, method, reqPath, body = '') {
  const msg = `${timestamp}${method.toUpperCase()}${reqPath}${body}`;
  return crypto.createHmac('sha256', CONFIG.secret).update(msg).digest('base64');
}

function apiRequest(method, endpoint, params = {}, body = null) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    let reqPath = endpoint;
    if (method === 'GET' && Object.keys(params).length > 0) {
      reqPath = `${endpoint}?${new URLSearchParams(params).toString()}`;
    }
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'ACCESS-KEY':        CONFIG.apiKey,
      'ACCESS-SIGN':       sign(timestamp, method, reqPath, bodyStr),
      'ACCESS-TIMESTAMP':  timestamp,
      'ACCESS-PASSPHRASE': CONFIG.passphrase,
      'Content-Type':      'application/json',
    };
    const req = https.request(
      { hostname: CONFIG.baseUrl, port: 443, path: reqPath, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.code !== '00000') {
              reject(new Error(`API [${parsed.code}]: ${parsed.msg} | ${reqPath}`));
            } else {
              resolve(parsed.data);
            }
          } catch (e) {
            reject(new Error(`Parse error: ${e.message} | raw: ${data}`));
          }
        });
      }
    );
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

// ─── CANDLE DATA ─────────────────────────────────────────────────────────────

async function getCandles(symbol) {
  const raw = await apiRequest('GET', '/api/v2/mix/market/candles', {
    symbol,
    productType: CONFIG.productType,
    granularity: CONFIG.granularity,
    limit: String(CONFIG.candleLimit),
  });
  return raw.reverse().map(c => ({
    ts:    parseInt(c[0]),
    open:  parseFloat(c[1]),
    high:  parseFloat(c[2]),
    low:   parseFloat(c[3]),
    close: parseFloat(c[4]),
    vol:   parseFloat(c[5]),
  }));
}

// ─── SWING POINTS ────────────────────────────────────────────────────────────

function detectSwings(candles) {
  const n = CONFIG.swingLookback;
  const highs = [], lows = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];
    let isHigh = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j !== i && candles[j].high >= c.high) { isHigh = false; break; }
    }
    if (isHigh) highs.push({ index: i, price: c.high, ts: c.ts });
    let isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j !== i && candles[j].low <= c.low) { isLow = false; break; }
    }
    if (isLow) lows.push({ index: i, price: c.low, ts: c.ts });
  }
  return { highs, lows };
}

// ─── TREND ───────────────────────────────────────────────────────────────────

function detectTrend(swings) {
  const recentHighs = swings.highs.slice(-4);
  const recentLows  = swings.lows.slice(-4);
  if (recentHighs.length < 2 || recentLows.length < 2) return 'sideways';
  const higherHighs = recentHighs.every((h, i) => i === 0 || h.price > recentHighs[i-1].price);
  const higherLows  = recentLows.every((l, i)  => i === 0 || l.price > recentLows[i-1].price);
  const lowerLows   = recentLows.every((l, i)  => i === 0 || l.price < recentLows[i-1].price);
  const lowerHighs  = recentHighs.every((h, i) => i === 0 || h.price < recentHighs[i-1].price);
  if (higherHighs && higherLows) return 'uptrend';
  if (lowerLows   && lowerHighs) return 'downtrend';
  return 'sideways';
}

// ─── BOS / MSS ───────────────────────────────────────────────────────────────

function detectBOS(candles, swings, trend) {
  const current = candles[candles.length - 1];
  if (trend === 'uptrend' && swings.lows.length >= 2) {
    const sigLow = swings.lows[swings.lows.length - 2];
    if (current.close < sigLow.price)
      return { detected: true, direction: 'bearish', keyLevel: sigLow.price };
  }
  if (trend === 'downtrend' && swings.highs.length >= 2) {
    const sigHigh = swings.highs[swings.highs.length - 2];
    if (current.close > sigHigh.price)
      return { detected: true, direction: 'bullish', keyLevel: sigHigh.price };
  }
  return { detected: false };
}

// ─── ZONE ────────────────────────────────────────────────────────────────────

function identifyZone(candles, swings, bosDirection) {
  const pivot = bosDirection === 'bearish'
    ? swings.highs[swings.highs.length - 1]
    : swings.lows[swings.lows.length - 1];
  if (!pivot) return null;
  const start     = Math.max(0, pivot.index - CONFIG.zoneCandles);
  const zoneSlice = candles.slice(start, pivot.index + 1);
  if (!zoneSlice.length) return null;
  return {
    high:       Math.max(...zoneSlice.map(c => c.high)),
    low:        Math.min(...zoneSlice.map(c => c.low)),
    pivotIndex: pivot.index,
  };
}

function inZone(price, zone) { return price >= zone.low && price <= zone.high; }

// ─── REJECTION ───────────────────────────────────────────────────────────────

function hasRejection(candles, direction) {
  return candles.slice(-3).some(c => {
    const range = c.high - c.low;
    if (range === 0) return false;
    const body = Math.abs(c.close - c.open);
    if (direction === 'bearish') {
      const upperWick = c.high - Math.max(c.open, c.close);
      return (upperWick / range > 0.30) || (c.close > c.open && body / range < 0.30);
    } else {
      const lowerWick = Math.min(c.open, c.close) - c.low;
      return (lowerWick / range > 0.30) || (c.close < c.open && body / range < 0.30);
    }
  });
}

// ─── ENTRY TRIGGER ───────────────────────────────────────────────────────────

function hasEntryTrigger(candles, direction) {
  const trigger   = candles[candles.length - 2];
  const range     = trigger.high - trigger.low;
  if (range === 0) return false;
  const bodyRatio = Math.abs(trigger.close - trigger.open) / range;
  return direction === 'bearish'
    ? trigger.close < trigger.open && bodyRatio > 0.40
    : trigger.close > trigger.open && bodyRatio > 0.40;
}

// ─── RISK & POSITION SIZING ───────────────────────────────────────────────────

function calcRisk(entry, zone, direction, balance, symbol) {
  const pairConf = PAIR_CONFIG[symbol] || { minSize: 0.001, sizePrecision: 3 };
  let sl, tp, slPct;
  if (direction === 'bearish') {
    sl    = zone.high;
    slPct = (sl - entry) / entry * 100;
    tp    = entry - (sl - entry) * CONFIG.rrRatio;
  } else {
    sl    = zone.low;
    slPct = (entry - sl) / entry * 100;
    tp    = entry + (entry - sl) * CONFIG.rrRatio;
  }
  if (slPct <= 0)                  return null;
  if (slPct < CONFIG.minSLPercent) return { skip: true, reason: `SL too tight (${slPct.toFixed(3)}%)` };
  if (slPct > CONFIG.maxSLPercent) return { skip: true, reason: `SL too wide (${slPct.toFixed(2)}%)` };
  const rr = Math.abs(tp - entry) / Math.abs(sl - entry);
  if (rr < CONFIG.rrRatio)         return { skip: true, reason: `RR ${rr.toFixed(2)} below ${CONFIG.rrRatio}` };
  const leverage      = Math.max(1, Math.min(Math.floor(CONFIG.riskPercent / slPct), CONFIG.maxLeverage));
  const riskAmount    = balance * (CONFIG.riskPercent / 100);
  const positionValue = riskAmount * leverage;
  let contractSize    = positionValue / entry;
  contractSize        = parseFloat(contractSize.toFixed(pairConf.sizePrecision));
  contractSize        = Math.max(contractSize, pairConf.minSize);
  return { sl, tp, slPct, leverage, riskAmount, positionValue, contractSize, rr, pairConf };
}

// ─── SET LEVERAGE ────────────────────────────────────────────────────────────

async function setLeverage(symbol, leverage, side) {
  await apiRequest('POST', '/api/v2/mix/account/set-leverage', {}, {
    symbol,
    productType: CONFIG.productType,
    marginCoin:  'USDT',
    leverage:    String(leverage),
    holdSide:    side,
  });
}

// ─── PLACE ORDER WITH SL & TP ─────────────────────────────────────────────────
// presetStopLossPrice and presetTakeProfitPrice attach SL/TP to the position
// the moment the market order fills — active from the very first tick.

async function placeOrder(symbol, direction, sl, tp, contractSize, pairConf) {
  const side = direction === 'bullish' ? 'buy' : 'sell';
  const body = {
    symbol,
    productType:           CONFIG.productType,
    marginMode:            'crossed',
    marginCoin:            'USDT',
    size:                  contractSize.toFixed(pairConf.sizePrecision),
    side,
    tradeSide:             'open',
    orderType:             'market',
    presetStopLossPrice:   sl.toFixed(4),   // Stop Loss attached to position
    presetTakeProfitPrice: tp.toFixed(4),   // Take Profit attached to position
  };
  return await apiRequest('POST', '/api/v2/mix/order/place-order', {}, body);
}

// ─── LOG TRADE ───────────────────────────────────────────────────────────────

function logTrade(tradeData) {
  const dir = path.dirname(CONFIG.logFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let log = { balance: 0, trades: [] };
  if (fs.existsSync(CONFIG.logFile)) {
    try { log = JSON.parse(fs.readFileSync(CONFIG.logFile, 'utf8')); } catch (_) {}
  }
  log.trades.push(tradeData);
  log.lastUpdated = new Date().toISOString();
  fs.writeFileSync(CONFIG.logFile, JSON.stringify(log, null, 2));
}

// ─── ANALYSE PAIR ────────────────────────────────────────────────────────────

async function analysePair(symbol, balance) {
  console.log(`\n--- Scanning ${symbol} ---`);
  const candles = await getCandles(symbol);
  const entry   = candles[candles.length - 1].close;
  console.log(`  Price: ${entry}`);

  const swings = detectSwings(candles);
  const trend  = detectTrend(swings);
  console.log(`  Trend: ${trend} | Highs: ${swings.highs.length} | Lows: ${swings.lows.length}`);

  if (trend === 'sideways') {
    console.log(`  SKIP — sideways, no MSS setup`);
    return { symbol, action: 'skip', reason: 'sideways market' };
  }

  const bos = detectBOS(candles, swings, trend);
  if (!bos.detected) {
    console.log(`  SKIP — no BOS yet`);
    return { symbol, action: 'skip', reason: 'no BOS detected' };
  }
  console.log(`  BOS: ${bos.direction.toUpperCase()} | level: ${bos.keyLevel}`);

  const zone = identifyZone(candles, swings, bos.direction);
  if (!zone) {
    console.log(`  SKIP — zone not identifiable`);
    return { symbol, action: 'skip', reason: 'zone not identified' };
  }
  console.log(`  Zone: ${zone.low.toFixed(4)} — ${zone.high.toFixed(4)}`);

  if (!inZone(entry, zone)) {
    const zStr = `${zone.low.toFixed(4)}–${zone.high.toFixed(4)}`;
    console.log(`  WAIT — price not in zone (pullback to ${zStr})`);
    return { symbol, action: 'wait', reason: `waiting for pullback into zone ${zStr}` };
  }
  console.log(`  Price inside zone`);

  if (!hasRejection(candles, bos.direction)) {
    console.log(`  WAIT — no rejection yet`);
    return { symbol, action: 'wait', reason: 'waiting for rejection at zone' };
  }
  console.log(`  Rejection confirmed`);

  if (!hasEntryTrigger(candles, bos.direction)) {
    console.log(`  WAIT — no trigger candle yet`);
    return { symbol, action: 'wait', reason: 'waiting for trigger candle' };
  }
  console.log(`  Trigger confirmed`);

  const risk = calcRisk(entry, zone, bos.direction, balance, symbol);
  if (!risk || risk.skip) {
    const reason = risk?.reason || 'invalid SL';
    console.log(`  SKIP — ${reason}`);
    return { symbol, action: 'skip', reason };
  }

  const direction = bos.direction === 'bearish' ? 'SHORT' : 'LONG';
  console.log(`  SIGNAL: ${direction}`);
  console.log(`    Entry : ${entry}`);
  console.log(`    SL    : ${risk.sl.toFixed(4)}  (${risk.slPct.toFixed(3)}% away)`);
  console.log(`    TP    : ${risk.tp.toFixed(4)}  (RR 1:${risk.rr.toFixed(2)})`);
  console.log(`    Lev   : ${risk.leverage}x | Position: $${risk.positionValue.toFixed(2)} | Size: ${risk.contractSize}`);

  if (CONFIG.dryRun) {
    console.log(`  DRY RUN — order NOT placed`);
    return { symbol, action: 'signal', direction, entry, sl: risk.sl, tp: risk.tp, leverage: risk.leverage, dryRun: true };
  }

  try {
    await setLeverage(symbol, risk.leverage, direction === 'LONG' ? 'long' : 'short');
    const result = await placeOrder(symbol, bos.direction, risk.sl, risk.tp, risk.contractSize, risk.pairConf);
    console.log(`  ORDER PLACED — orderId: ${result.orderId}`);
    console.log(`    SL: ${risk.sl.toFixed(4)}  TP: ${risk.tp.toFixed(4)}`);

    const tradeLog = {
      id:            result.orderId || `${symbol}-${Date.now()}`,
      pair:          symbol,
      type:          direction,
      entryPrice:    entry,
      stopPrice:     risk.sl,
      tpPrice:       risk.tp,
      leverage:      risk.leverage,
      contractSize:  String(risk.contractSize),
      positionValue: risk.positionValue.toFixed(2),
      riskAmount:    risk.riskAmount.toFixed(2),
      slPct:         risk.slPct.toFixed(3),
      rr:            risk.rr.toFixed(2),
      outcome:       null,
      pnlAmount:     null,
      pnlPct:        null,
      timestamp:     new Date().toISOString(),
      live:          !CONFIG.demo,
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
    console.error('ERROR: No API credentials found.');
    process.exit(1);
  }

  const line = '='.repeat(60);
  console.log(`\n${line}`);
  console.log('CLAWBOT — Bitget Futures MSS/BOS Strategy');
  console.log(`Mode    : ${CONFIG.demo ? 'DEMO (paper)' : 'LIVE (real money)'}`);
  console.log(`Orders  : ${CONFIG.dryRun ? 'DRY RUN — analysis only' : 'REAL ORDERS ENABLED'}`);
  console.log(`Pairs   : ${CONFIG.pairs.join(', ')}  |  TF: ${CONFIG.granularity}`);
  console.log(`Risk    : ${CONFIG.riskPercent}% / trade | Max lev: ${CONFIG.maxLeverage}x | RR: 1:${CONFIG.rrRatio}`);
  console.log(line);

  const balance = await getBalance();
  console.log(`\nAvailable USDT: $${balance.toFixed(2)}`);

  const results = [];
  for (const pair of CONFIG.pairs) {
    try {
      results.push(await analysePair(pair, balance));
    } catch (err) {
      console.error(`\nERROR on ${pair}: ${err.message}`);
      results.push({ symbol: pair, action: 'error', reason: err.message });
    }
  }

  console.log(`\n${line}`);
  console.log('SCAN SUMMARY');
  console.log(line);
  for (const r of results) {
    const tag = { traded: '>>> TRADE PLACED', signal: '>>> SIGNAL (dry)', wait: 'WAIT', skip: 'SKIP', error: 'ERROR' }[r.action] || r.action;
    const detail = r.direction || r.reason || '';
    console.log(`  ${r.symbol.padEnd(10)} ${tag.padEnd(20)} ${detail}`);
  }

  console.log('\nRESULTS_JSON:' + JSON.stringify(results));
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
```

### Step 2 — Run the script

```bash
node /tmp/bitget-trader.js
```

No env vars needed — credentials are built in and **live mode is the default**.

Override flags (optional):
```bash
DRY_RUN=true node /tmp/bitget-trader.js       # analyse only, no real orders
BITGET_DEMO=true node /tmp/bitget-trader.js    # force demo/paper mode
```

### Step 3 — Parse and display results

Present a clean summary:
- Account balance
- Each pair: action taken (trade placed / waiting / skipped) with details
- For trades: entry, SL price, TP price, leverage, position size, order ID
- For skips/waits: brief reason

### Step 4 — Confirm log (if trade placed)

```bash
cat /data/.openclaw/workspace/logs/virtual-trades.json | tail -c 800
```

Report the latest trade entry.

---

## Strategy Rules

### Entry — SHORT
1. **Uptrend confirmed** (HH + HL series)
2. **Bearish BOS**: close breaks below a significant swing low → structure shifts
3. **Pullback**: price retraces up into the supply zone (base before last swing high)
4. **Rejection**: upper wicks > 30% range or weak bullish body in zone
5. **Trigger**: strong bearish candle closes from zone (body/range > 40%)

### Entry — LONG
1. **Downtrend confirmed** (LL + LH series)
2. **Bullish BOS**: close breaks above a significant swing high → structure shifts
3. **Pullback**: price retraces down into the demand zone (base before last swing low)
4. **Rejection**: lower wicks > 30% range or weak bearish body in zone
5. **Trigger**: strong bullish candle closes from zone (body/range > 40%)

### Risk Management
| Parameter | Value |
|-----------|-------|
| Risk per trade | 10% of account |
| Leverage | `10 / SL%` capped at 25x |
| Stop Loss | Top of supply zone (SHORT) / Bottom of demand zone (LONG) |
| Take Profit | 1.5× the risk distance from entry |
| Min SL% | 0.05% (skip if tighter) |
| Max SL% | 10% (skip if wider) |

SL and TP are placed as **preset orders** attached to the position on fill — active from the very first tick after the market order executes.

---

## Wrap Up

Summarise:
1. **Mode** — live or demo, dry run or real
2. **Balance** — available USDT
3. **Trades placed** — entry, SL, TP, leverage, order ID for each
4. **Signals waiting** — pairs with BOS but no pullback/trigger yet
5. **Skipped** — reason per pair
6. **Next scan** — suggest re-running in 1 hour

To automate hourly scans:
```bash
0 * * * * node /path/to/bitget-trader.js >> /data/.openclaw/workspace/logs/clawbot.log 2>&1
```
