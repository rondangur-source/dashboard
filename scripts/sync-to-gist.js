#!/usr/bin/env node
/**
 * Dashboard Sync to GitHub Gist
 * Updates the gist with latest MSS Trader data
 * 
 * Usage: node sync-to-gist.js [gist-id]
 * Gist ID: c750c53b60430cd38cc5793c9efd0e7e
 */

const fs = require('fs');
const https = require('https');

const GIST_ID = process.argv[2] || 'c750c53b60430cd38cc5793c9efd0e7e';
const TOKEN = process.env.GITHUB_TOKEN || '';

// Paths
const VIRTUAL_TRADES_PATH = '/data/.openclaw/workspace/logs/virtual-trades.json';

function loadTrades() {
    try {
        if (!fs.existsSync(VIRTUAL_TRADES_PATH)) {
            console.log('[sync] No trades file found, using empty data');
            return createEmptyData();
        }
        const tradesData = JSON.parse(fs.readFileSync(VIRTUAL_TRADES_PATH, 'utf8'));
        return processTradesData(tradesData);
    } catch (err) {
        console.error('[sync] Error loading trades:', err.message);
        return createEmptyData();
    }
}

function processTradesData(data) {
    const trades = data.trades || [];
    const stats = calculateStats(trades);
    const activeTrades = trades.filter(t => t.status === 'open');
    const closedTrades = trades.filter(t => t.status === 'closed');
    const recentTrades = closedTrades.slice(-20).reverse();
    const balanceHistory = calculateBalanceHistory(trades);

    return {
        timestamp: new Date().toISOString(),
        stats: {
            balance: data.balance || 100,
            totalTrades: trades.length,
            wins: stats.wins,
            losses: stats.losses,
            winRate: stats.winRate,
            totalPnL: Math.round(stats.totalPnL * 100) / 100,
            grossProfit: Math.round(stats.grossProfit * 100) / 100,
            grossLoss: Math.round(stats.grossLoss * 100) / 100,
            bestTrade: stats.bestTrade,
            worstTrade: stats.worstTrade,
            avgTrade: Math.round(stats.avgTrade * 100) / 100
        },
        activeTrades: activeTrades.map(t => formatTrade(t)),
        recentTrades: recentTrades.map(t => formatTrade(t)),
        balanceHistory: balanceHistory,
        tradingStatus: {
            isActive: isTradingHours(),
            sessionStart: getSessionStartTime(),
            nextScan: getNextScanTime(),
            pair: 'BTCUSDT',
            strategy: 'MSS v6 - ATR Dynamic SL'
        }
    };
}

function calculateStats(trades) {
    const closed = trades.filter(t => t.status === 'closed');
    if (closed.length === 0) {
        return { wins: 0, losses: 0, winRate: 0, totalPnL: 0, grossProfit: 0, grossLoss: 0, bestTrade: null, worstTrade: null, avgTrade: 0 };
    }
    
    const wins = closed.filter(t => t.pnl > 0);
    const losses = closed.filter(t => t.pnl <= 0);
    const winRate = Math.round((wins.length / closed.length) * 100);
    const totalPnL = closed.reduce((sum, t) => sum + t.pnl, 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
    const sortedByPnL = [...closed].sort((a, b) => b.pnl - a.pnl);
    
    return {
        wins: wins.length,
        losses: losses.length,
        winRate,
        totalPnL,
        grossProfit,
        grossLoss,
        bestTrade: sortedByPnL[0]?.pnl || null,
        worstTrade: sortedByPnL[sortedByPnL.length - 1]?.pnl || null,
        avgTrade: closed.length > 0 ? totalPnL / closed.length : 0
    };
}

function calculateBalanceHistory(trades) {
    const history = [{ time: 'Start', balance: 100 }];
    let runningBalance = 100;
    const closed = trades.filter(t => t.status === 'closed');
    closed.forEach(trade => {
        runningBalance += trade.pnl;
        history.push({ time: trade.exitTime || trade.time, balance: Math.round(runningBalance * 100) / 100 });
    });
    history.push({ time: 'Now', balance: Math.round(runningBalance * 100) / 100 });
    return history;
}

function formatTrade(trade) {
    return {
        id: trade.id,
        pair: trade.pair || 'BTCUSDT',
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        atr: trade.atr,
        pnl: Math.round(trade.pnl * 100) / 100,
        pnlPercent: trade.pnlPercent,
        status: trade.status,
        entryTime: trade.entryTime,
        exitTime: trade.exitTime,
        currentPrice: trade.currentPrice,
        unrealizedPnL: trade.unrealizedPnL,
        progressToSL: trade.progressToSL,
        progressToTP: trade.progressToTP,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit
    };
}

function isTradingHours() {
    const now = new Date();
    const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const day = israelTime.getDay();
    const hour = israelTime.getHours();
    return day >= 0 && day <= 4 && (hour >= 10 || hour === 0);
}

function getSessionStartTime() {
    const now = new Date();
    const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const today = israelTime.toDateString();
    return new Date(`${today} 10:00`).toISOString();
}

function getNextScanTime() {
    const now = new Date();
    const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const next = new Date(israelTime);
    next.setMinutes(next.getMinutes() + 1);
    return next.toISOString();
}

function createEmptyData() {
    return {
        timestamp: new Date().toISOString(),
        stats: { balance: 100, totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnL: 0, grossProfit: 0, grossLoss: 0, bestTrade: null, worstTrade: null, avgTrade: 0 },
        activeTrades: [],
        recentTrades: [],
        balanceHistory: [{ time: 'Start', balance: 100 }, { time: 'Now', balance: 100 }],
        tradingStatus: { isActive: isTradingHours(), sessionStart: getSessionStartTime(), nextScan: getNextScanTime(), pair: 'BTCUSDT', strategy: 'MSS v6 - ATR Dynamic SL' }
    };
}

function updateGist(data) {
    const content = JSON.stringify(data, null, 2);
    
    const patchData = JSON.stringify({
        description: 'MSS Trader Dashboard Data - Updated ' + new Date().toISOString(),
        files: {
            'dashboard-data.json': {
                content: content
            }
        }
    });

    const options = {
        hostname: 'api.github.com',
        path: `/gists/${GIST_ID}`,
        method: 'PATCH',
        headers: {
            'Authorization': `token ${TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(patchData),
            'User-Agent': 'TeamDashboard/1.0'
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(responseData);
                    if (json.id) {
                        console.log(`[${new Date().toISOString()}] Gist updated successfully`);
                        console.log(`Stats: Balance $${data.stats.balance} | ${data.stats.totalTrades} trades | ${data.stats.winRate}% WR`);
                        resolve(json);
                    } else {
                        console.log('Gist update error:', json.message);
                        reject(json);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        
        req.on('error', reject);
        req.write(patchData);
        req.end();
    });
}

// Main
const data = loadTrades();
updateGist(data)
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Error:', err);
        process.exit(1);
    });