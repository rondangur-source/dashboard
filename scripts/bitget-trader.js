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
  granularity: '1m',
  candleLimit: 100,
  maxLeverage: 25,
  riskPercent: 10,       // % of account risked per trade
  rrRatio:     1.5,      // take-profit risk-reward ratio
  swingLookback: 3,      // candles each side to confirm a swing point
  zoneCandles:   8,      // candles before the swing that define the zone
  maxSLPercent:  10,     // skip trade if SL distance > this %
  minSLPercent:  0.05,   // skip trade if SL distance < this % (leverage would be extreme)
  logFile: '/data/.openclaw/workspace/logs/virtual-trades.json',
};

// Per-pair minimum order size and decimal precision for Bitget USDT-FUTURES
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

    const bodyStr  = body ? JSON.stringify(body) : '';
    const headers  = {
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
// Returns oldest-first: [{ ts, open, high, low, close, vol }]

async function getCandles(symbol) {
  const raw = await apiRequest('GET', '/api/v2/mix/market/candles', {
    symbol,
    productType: CONFIG.productType,
    granularity: CONFIG.granularity,
    limit: String(CONFIG.candleLimit),
  });
  // Bitget returns newest-first → reverse to oldest-first
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
  const n     = CONFIG.swingLookback;
  const highs = [];
  const lows  = [];

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

// ─── TREND DETECTION ─────────────────────────────────────────────────────────
// Returns 'uptrend' | 'downtrend' | 'sideways'

function detectTrend(swings) {
  const recentHighs = swings.highs.slice(-4);
  const recentLows  = swings.lows.slice(-4);

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
// Returns { detected, direction: 'bullish'|'bearish', keyLevel }

function detectBOS(candles, swings, trend) {
  const current = candles[candles.length - 1];

  if (trend === 'uptrend' && swings.lows.length >= 2) {
    // Bearish BOS: close breaks below the significant swing low before the last higher high
    const sigLow = swings.lows[swings.lows.length - 2];
    if (current.close < sigLow.price) {
      return { detected: true, direction: 'bearish', keyLevel: sigLow.price };
    }
  }

  if (trend === 'downtrend' && swings.highs.length >= 2) {
    // Bullish BOS: close breaks above the significant swing high before the last lower low
    const sigHigh = swings.highs[swings.highs.length - 2];
    if (current.close > sigHigh.price) {
      return { detected: true, direction: 'bullish', keyLevel: sigHigh.price };
    }
  }

  return { detected: false };
}

// ─── SUPPLY / DEMAND ZONE ────────────────────────────────────────────────────
// Zone = the consolidation base before the swing that caused the BOS

function identifyZone(candles, swings, bosDirection) {
  const pivot = bosDirection === 'bearish'
    ? swings.highs[swings.highs.length - 1]   // supply zone: around the last swing high
    : swings.lows[swings.lows.length - 1];     // demand zone: around the last swing low

  if (!pivot) return null;

  const start      = Math.max(0, pivot.index - CONFIG.zoneCandles);
  const zoneSlice  = candles.slice(start, pivot.index + 1);
  if (zoneSlice.length === 0) return null;

  return {
    high:       Math.max(...zoneSlice.map(c => c.high)),
    low:        Math.min(...zoneSlice.map(c => c.low)),
    pivotIndex: pivot.index,
  };
}

// ─── PULLBACK CHECK ───────────────────────────────────────────────────────────

function inZone(price, zone) {
  return price >= zone.low && price <= zone.high;
}

// ─── REJECTION CHECK ─────────────────────────────────────────────────────────
// Looks for wicks or weak-body candles in last 3 candles showing counter-pressure

function hasRejection(candles, direction) {
  return candles.slice(-3).some(c => {
    const range = c.high - c.low;
    if (range === 0) return false;
    const body = Math.abs(c.close - c.open);

    if (direction === 'bearish') {
      const upperWick = c.high - Math.max(c.open, c.close);
      // Upper wick > 30% of range  OR  weak bullish body (< 30% of range)
      return (upperWick / range > 0.30) || (c.close > c.open && body / range < 0.30);
    } else {
      const lowerWick = Math.min(c.open, c.close) - c.low;
      // Lower wick > 30% of range  OR  weak bearish body (< 30% of range)
      return (lowerWick / range > 0.30) || (c.close < c.open && body / range < 0.30);
    }
  });
}

// ─── ENTRY TRIGGER ───────────────────────────────────────────────────────────
// Last CLOSED candle (second-to-last) must be a strong directional candle

function hasEntryTrigger(candles, direction) {
  const trigger   = candles[candles.length - 2];
  const range     = trigger.high - trigger.low;
  if (range === 0) return false;
  const bodyRatio = Math.abs(trigger.close - trigger.open) / range;

  return direction === 'bearish'
    ? trigger.close < trigger.open && bodyRatio > 0.40   // strong bearish candle
    : trigger.close > trigger.open && bodyRatio > 0.40;  // strong bullish candle
}

// ─── RISK & POSITION SIZING ───────────────────────────────────────────────────
// Dynamic leverage so that a SL hit = exactly 10% of account lost.
//
//   SL%      = distance from entry to SL as a percent of entry price
//   Leverage = 10 / SL%   (capped at maxLeverage)
//   Risk $   = balance × 10%
//   Position = Risk $ × Leverage
//   Contracts= Position / entry price   (rounded to pair minimum)

function calcRisk(entry, zone, direction, balance, symbol) {
  const pairConf = PAIR_CONFIG[symbol] || { minSize: 0.001, sizePrecision: 3 };

  let sl, tp, slPct;

  if (direction === 'bearish') {
    sl    = zone.high;                                   // SL above supply zone
    slPct = (sl - entry) / entry * 100;
    tp    = entry - (sl - entry) * CONFIG.rrRatio;       // TP at 1.5× risk
  } else {
    sl    = zone.low;                                    // SL below demand zone
    slPct = (entry - sl) / entry * 100;
    tp    = entry + (entry - sl) * CONFIG.rrRatio;       // TP at 1.5× risk
  }

  if (slPct <= 0)                    return null;
  if (slPct < CONFIG.minSLPercent)   return { skip: true, reason: `SL too tight (${slPct.toFixed(3)}%) — leverage would exceed safe limit` };
  if (slPct > CONFIG.maxSLPercent)   return { skip: true, reason: `SL too wide (${slPct.toFixed(2)}%) — risk per leverage unit too high` };

  const rr = Math.abs(tp - entry) / Math.abs(sl - entry);
  if (rr < CONFIG.rrRatio) return { skip: true, reason: `RR ${rr.toFixed(2)} below minimum ${CONFIG.rrRatio}` };

  const leverage      = Math.max(1, Math.min(Math.floor(CONFIG.riskPercent / slPct), CONFIG.maxLeverage));
  const riskAmount    = balance * (CONFIG.riskPercent / 100);
  const positionValue = riskAmount * leverage;

  // Round contract size to pair precision and enforce minimum
  let contractSize = positionValue / entry;
  contractSize     = parseFloat(contractSize.toFixed(pairConf.sizePrecision));
  contractSize     = Math.max(contractSize, pairConf.minSize);

  return { sl, tp, slPct, leverage, riskAmount, positionValue, contractSize, rr, pairConf };
}

// ─── SET LEVERAGE ────────────────────────────────────────────────────────────

async function setLeverage(symbol, leverage, side) {
  // side: 'long' | 'short' — required by Bitget v2 even in crossed margin mode
  await apiRequest('POST', '/api/v2/mix/account/set-leverage', {}, {
    symbol,
    productType: CONFIG.productType,
    marginCoin:  'USDT',
    leverage:    String(leverage),
    holdSide:    side,
  });
}

// ─── PLACE MARKET ORDER WITH PRESET SL & TP ──────────────────────────────────
// Uses Bitget v2 place-order with presetStopLossPrice + presetTakeProfitPrice.
// These are attached to the position the moment the market order fills,
// so SL and TP are active from the very first tick.

async function placeOrder(symbol, direction, sl, tp, contractSize, pairConf) {
  const side = direction === 'bullish' ? 'buy' : 'sell';
  const size = contractSize.toFixed(pairConf.sizePrecision);

  const body = {
    symbol,
    productType:            CONFIG.productType,
    marginMode:             'crossed',
    marginCoin:             'USDT',
    size,
    side,
    tradeSide:              'open',
    orderType:              'market',
    presetStopLossPrice:    sl.toFixed(4),    // ← Stop Loss attached to position
    presetTakeProfitPrice:  tp.toFixed(4),    // ← Take Profit attached to position
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
    console.log(`  SKIP — sideways market, no MSS setup`);
    return { symbol, action: 'skip', reason: 'sideways market' };
  }

  const bos = detectBOS(candles, swings, trend);
  if (!bos.detected) {
    console.log(`  SKIP — no BOS/MSS yet`);
    return { symbol, action: 'skip', reason: 'no BOS detected' };
  }
  console.log(`  BOS: ${bos.direction.toUpperCase()} | key level: ${bos.keyLevel}`);

  const zone = identifyZone(candles, swings, bos.direction);
  if (!zone) {
    console.log(`  SKIP — zone not identifiable`);
    return { symbol, action: 'skip', reason: 'zone not identified' };
  }
  console.log(`  Zone: ${zone.low.toFixed(4)} — ${zone.high.toFixed(4)}`);

  if (!inZone(entry, zone)) {
    const zoneStr = `${zone.low.toFixed(4)}–${zone.high.toFixed(4)}`;
    console.log(`  WAIT — price not in zone yet (waiting for pullback to ${zoneStr})`);
    return { symbol, action: 'wait', reason: `waiting for pullback into zone ${zoneStr}` };
  }
  console.log(`  Price is inside zone`);

  if (!hasRejection(candles, bos.direction)) {
    console.log(`  WAIT — no rejection signal at zone yet`);
    return { symbol, action: 'wait', reason: 'waiting for rejection at zone' };
  }
  console.log(`  Rejection confirmed`);

  if (!hasEntryTrigger(candles, bos.direction)) {
    console.log(`  WAIT — no trigger candle yet`);
    return { symbol, action: 'wait', reason: 'waiting for trigger candle' };
  }
  console.log(`  Entry trigger confirmed`);

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
  console.log(`    Lev   : ${risk.leverage}x  |  Position: $${risk.positionValue.toFixed(2)}  |  Size: ${risk.contractSize} contracts`);

  if (CONFIG.dryRun) {
    console.log(`  DRY RUN — order NOT placed`);
    return { symbol, action: 'signal', direction, entry, sl: risk.sl, tp: risk.tp, leverage: risk.leverage, dryRun: true };
  }

  try {
    // Set leverage for the specific side before opening the position
    await setLeverage(symbol, risk.leverage, direction === 'LONG' ? 'long' : 'short');

    // Place market order — SL and TP are attached via presetStopLossPrice / presetTakeProfitPrice
    const result = await placeOrder(symbol, bos.direction, risk.sl, risk.tp, risk.contractSize, risk.pairConf);

    console.log(`  ORDER PLACED — orderId: ${result.orderId}`);
    console.log(`    SL attached : ${risk.sl.toFixed(4)}`);
    console.log(`    TP attached : ${risk.tp.toFixed(4)}`);

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
    console.error('ERROR: No API credentials found. Set BITGET_API_KEY, BITGET_API_SECRET, BITGET_PASSPHRASE.');
    process.exit(1);
  }

  const line = '='.repeat(60);
  console.log(`\n${line}`);
  console.log('CLAWBOT — Bitget Futures MSS/BOS Strategy');
  console.log(`Mode    : ${CONFIG.demo ? 'DEMO (paper)' : 'LIVE (real money)'}`);
  console.log(`Orders  : ${CONFIG.dryRun ? 'DRY RUN — analysis only' : 'REAL ORDERS ENABLED'}`);
  console.log(`Pairs   : ${CONFIG.pairs.join(', ')}  |  TF: ${CONFIG.granularity}`);
  console.log(`Risk    : ${CONFIG.riskPercent}% / trade  |  Max lev: ${CONFIG.maxLeverage}x  |  RR: 1:${CONFIG.rrRatio}`);
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
    const tag = {
      traded: '>>> TRADE PLACED',
      signal: '>>> SIGNAL (dry)',
      wait:   'WAIT',
      skip:   'SKIP',
      error:  'ERROR',
    }[r.action] || r.action;
    const detail = r.direction ? `${r.direction}` : (r.reason || '');
    console.log(`  ${r.symbol.padEnd(10)} ${tag.padEnd(20)} ${detail}`);
  }

  console.log('\nRESULTS_JSON:' + JSON.stringify(results));
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
