#!/usr/bin/env node
/**
 * Dashboard Sync Script
 * Updates dashboard data from MSS Trader logs
 * Run this via cron every 30 seconds or on-demand
 */

const fs = require('fs');
const path = require('path');

// Paths
const VIRTUAL_TRADES_PATH = path.join(__dirname, '../logs/virtual-trades.json');
const DATA_OUTPUT_PATH = path.join(__dirname, 'data/dashboard-data.json');

function loadTrades() {
    try {
        if (!fs.existsSync(VIRTUAL_TRADES_PATH)) {
            console.log('[sync] No trades file found, creating empty data');
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
    
    // Get last 20 closed trades for history
    const recentTrades = closedTrades.slice(-20).reverse();
    
    // Calculate balance history
    const balanceHistory = calculateBalanceHistory(trades);
    
    return {
        timestamp: new Date().toISOString(),
        stats: {
            balance: data.balance || 100,
            totalTrades: trades.length,
            wins: stats.wins,
            losses: stats.losses,
            winRate: stats.winRate,
            totalPnL: stats.totalPnL,
            grossProfit: stats.grossProfit,
            grossLoss: stats.grossLoss,
            bestTrade: stats.bestTrade,
            worstTrade: stats.worstTrade,
            avgTrade: stats.avgTrade
        },
        activeTrades: activeTrades.map(t => formatTrade(t)),
        recentTrades: recentTrades.map(t => formatTrade(t)),
        balanceHistory: balanceHistory,
        tradingStatus: {
            isActive: isTradingHours(),
            sessionStart: getSessionStartTime(),
            nextScan: getNextScanTime()
        }
    };
}

function calculateStats(trades) {
    const closed = trades.filter(t => t.status === 'closed');
    if (closed.length === 0) {
        return {
            wins: 0, losses: 0, winRate: 0,
            totalPnL: 0, grossProfit: 0, grossLoss: 0,
            bestTrade: null, worstTrade: null, avgTrade: 0
        };
    }
    
    const wins = closed.filter(t => t.pnl > 0);
    const losses = closed.filter(t => t.pnl <= 0);
    const winRate = Math.round((wins.length / closed.length) * 100);
    
    const totalPnL = closed.reduce((sum, t) => sum + t.pnl, 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
    
    const sortedByPnL = [...closed].sort((a, b) => b.pnl - a.pnl);
    const bestTrade = sortedByPnL[0]?.pnl || null;
    const worstTrade = sortedByPnL[sortedByPnL.length - 1]?.pnl || null;
    const avgTrade = totalPnL / closed.length;
    
    return { wins: wins.length, losses: losses.length, winRate, totalPnL, grossProfit, grossLoss, bestTrade, worstTrade, avgTrade };
}

function calculateBalanceHistory(trades) {
    const history = [{ time: 'Start', balance: 100 }];
    let runningBalance = 100;
    
    const closed = trades.filter(t => t.status === 'closed');
    closed.forEach(trade => {
        runningBalance += trade.pnl;
        history.push({
            time: trade.exitTime || trade.time,
            balance: Math.round(runningBalance * 100) / 100
        });
    });
    
    // Always add current balance
    history.push({ time: 'Now', balance: runningBalance });
    
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
        pnl: trade.pnl,
        pnlPercent: trade.pnlPercent,
        status: trade.status,
        entryTime: trade.entryTime,
        exitTime: trade.exitTime,
        // For active trades
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
    
    // Sun-Thu, 10:00-00:00
    const isWeekday = day >= 0 && day <= 4;
    const isWithinHours = hour >= 10 || hour === 0;
    
    return isWeekday && isWithinHours;
}

function getSessionStartTime() {
    const now = new Date();
    const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const today = israelTime.toDateString();
    
    // Today's 10:00 AM Israel
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
        stats: {
            balance: 100,
            totalTrades: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
            totalPnL: 0,
            grossProfit: 0,
            grossLoss: 0,
            bestTrade: null,
            worstTrade: null,
            avgTrade: 0
        },
        activeTrades: [],
        recentTrades: [],
        balanceHistory: [{ time: 'Start', balance: 100 }, { time: 'Now', balance: 100 }],
        tradingStatus: {
            isActive: isTradingHours(),
            sessionStart: getSessionStartTime(),
            nextScan: getNextScanTime()
        }
    };
}

function saveData(data) {
    try {
        // Ensure directory exists
        const dir = path.dirname(DATA_OUTPUT_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(DATA_OUTPUT_PATH, JSON.stringify(data, null, 2));
        console.log(`[sync] Dashboard data updated at ${data.timestamp}`);
    } catch (err) {
        console.error('[sync] Error saving data:', err.message);
    }
}

// Main execution
const data = loadTrades();
saveData(data);

module.exports = { loadTrades, processTradesData };