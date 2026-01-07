/**
 * Volatility Module
 * Calculates volatility from multiple sources for auto-slippage
 *
 * Three methods:
 * 1. IQR-based: Uses Coinbase trade data bucketed by settlement time (DISABLED - stale API)
 * 2. Candle-based: Uses Coinbase 1-minute OHLC candles, calculates rolling volatility
 * 3. Kraken-based: Uses Kraken trades bucketed into 15s intervals, σ scaled to 4s
 *
 * Final slippage = max(6.5x IQR, 1.5σ candle volatility, 6.5σ Kraken)
 */

import { CONFIG } from './config.js';

class VolatilityTracker {
    constructor() {
        this.lastIQR = null;
        this.lastCandleVol = null; // 1.5σ from 1-min candles
        this.lastKrakenVol = null; // 6.5σ from Kraken 15s buckets, scaled to 4s
        this.lastUpdate = 0;
        this.updateInterval = 30000; // 30 seconds
        this.listeners = new Set();
        this.calculating = false;
        this.intervalId = null;
        this.currentSettlementTime = null; // Track current settlement time
    }

    /**
     * Start periodic updates
     */
    start() {
        if (this.intervalId) return;

        // Initial calculation
        this.calculate();

        // Update every 30 seconds
        this.intervalId = setInterval(() => this.calculate(), this.updateInterval);
    }

    /**
     * Stop periodic updates
     */
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Update settlement time and recalculate
     */
    setSettlementTime(seconds) {
        const newTime = parseInt(seconds) || CONFIG.defaults.settlementTime || 4;
        if (newTime !== this.currentSettlementTime) {
            this.currentSettlementTime = newTime;
            console.log(`[Volatility] Settlement time changed to ${newTime}s, recalculating...`);
            this.calculate();
        }
    }

    /**
     * Calculate volatility from candles (trades method disabled - Coinbase API returning stale data)
     */
    async calculate(force = false) {
        if (this.calculating && !force) return this.lastIQR;
        this.calculating = true;

        const settlementTime = this.currentSettlementTime || CONFIG.defaults.settlementTime || 4;

        try {
            // Calculate both candle and Kraken volatility in parallel
            await Promise.all([
                this.calculateCandleVol(),
                this.calculateKrakenVol()
            ]);

            // Emit update
            this.emit({ iqr: this.lastIQR, candleVol: this.lastCandleVol, krakenVol: this.lastKrakenVol, returns: 0, settlementTime });
            this.calculating = false;
            return this.getRecommendedSlippage();

            /* DISABLED: Coinbase trades API returning stale data (14+ hours old)
            const bucketMs = settlementTime * 1000;
            const windowMs = 4 * 60 * 1000; // 4 minutes of data

            // Fetch trades from Coinbase
            const trades = await this.fetchTrades(windowMs);
            if (!trades || trades.length < 10) {
                console.warn('Not enough trades for IQR calculation');
                this.calculating = false;
                // Still emit with last known IQR so recalculating state clears
                this.emit({ iqr: this.lastIQR, returns: 0, settlementTime, fallback: true });
                return this.lastIQR;
            }

            // Create time buckets
            const buckets = this.createBuckets(trades, bucketMs, windowMs);
            console.log(`[Volatility DEBUG] trades=${trades.length}, buckets=${buckets.length}`);
            if (buckets.length < 4) {
                console.warn('Not enough buckets for IQR calculation');
                this.calculating = false;
                this.emit({ iqr: this.lastIQR, returns: 0, settlementTime, fallback: true });
                return this.lastIQR;
            }

            // Calculate returns between buckets
            const returns = this.calculateReturns(buckets);

            // Debug: show first few bucket prices and returns
            console.log(`[Volatility DEBUG] First 5 bucket prices:`, buckets.slice(0, 5).map(b => b.close));
            console.log(`[Volatility DEBUG] First 10 returns:`, returns.slice(0, 10).map(r => (r * 100).toFixed(6) + '%'));
            console.log(`[Volatility DEBUG] Non-zero returns: ${returns.filter(r => r !== 0).length}/${returns.length}`);

            if (returns.length < 4) {
                console.warn('Not enough returns for IQR calculation');
                this.calculating = false;
                this.emit({ iqr: this.lastIQR, returns: 0, settlementTime, fallback: true });
                return this.lastIQR;
            }

            // Calculate IQR
            const iqr = this.calculateIQR(returns);

            // Debug: show quartiles
            const sorted = [...returns].sort((a, b) => a - b);
            const q1 = sorted[Math.floor(sorted.length * 0.25)];
            const q3 = sorted[Math.floor(sorted.length * 0.75)];
            console.log(`[Volatility DEBUG] Q1=${(q1*100).toFixed(6)}%, Q3=${(q3*100).toFixed(6)}%, IQR=${(iqr*100).toFixed(6)}%`);

            this.lastIQR = iqr;
            this.lastUpdate = Date.now();

            console.log(`Volatility IQR: ${(iqr * 100).toFixed(4)}% (${returns.length} returns, ${settlementTime}s buckets)`);

            // Notify listeners
            this.emit({ iqr, candleVol: this.lastCandleVol, returns: returns.length, settlementTime });

            this.calculating = false;
            return iqr;
            */

        } catch (error) {
            console.error('Volatility calculation error:', error);
            this.calculating = false;
            // Emit with fallback so recalculating state clears
            this.emit({ iqr: this.lastIQR, returns: 0, settlementTime, fallback: true, error: true });
            return this.lastIQR;
        }
    }

    /**
     * Fetch trades from Coinbase going back windowMs
     */
    async fetchTrades(windowMs) {
        const allTrades = [];
        let lastTradeId = null;
        const targetTime = Date.now() - windowMs;

        for (let page = 1; page <= 10; page++) {
            const url = lastTradeId
                ? `https://api.exchange.coinbase.com/products/ETH-USD/trades?limit=1000&after=${lastTradeId}`
                : `https://api.exchange.coinbase.com/products/ETH-USD/trades?limit=1000`;

            try {
                const response = await fetch(url);
                if (!response.ok) break;

                const trades = await response.json();
                if (!trades || trades.length === 0) break;

                allTrades.push(...trades);

                // Check if we have enough data
                const oldestTrade = trades[trades.length - 1];
                const oldestTime = new Date(oldestTrade.time).getTime();

                if (oldestTime < targetTime) break;

                lastTradeId = parseInt(oldestTrade.trade_id);

                if (trades.length < 100) break;

            } catch (error) {
                console.error(`Failed to fetch trades page ${page}:`, error);
                break;
            }
        }

        return allTrades;
    }

    /**
     * Create time buckets from trades
     */
    createBuckets(trades, bucketMs, windowMs) {
        if (!trades.length) return [];

        // Sort by time ascending
        const sorted = [...trades].sort((a, b) =>
            new Date(a.time).getTime() - new Date(b.time).getTime()
        );

        // Debug: check time range and price range
        const oldestTrade = sorted[0];
        const newestTrade = sorted[sorted.length - 1];
        const oldestTime = new Date(oldestTrade.time).getTime();
        const newestTime = new Date(newestTrade.time).getTime();
        const timeRangeSec = (newestTime - oldestTime) / 1000;

        console.log(`[Volatility DEBUG] Trade time range: ${timeRangeSec.toFixed(1)}s`);
        console.log(`[Volatility DEBUG] Oldest: ${oldestTrade.time} @ $${oldestTrade.price}`);
        console.log(`[Volatility DEBUG] Newest: ${newestTrade.time} @ $${newestTrade.price}`);
        console.log(`[Volatility DEBUG] Now: ${new Date().toISOString()}`);

        const mostRecentTime = newestTime;
        const oldestAllowed = mostRecentTime - windowMs;

        // Group into buckets
        const bucketMap = new Map();

        for (const trade of sorted) {
            const tradeTime = new Date(trade.time).getTime();
            if (tradeTime < oldestAllowed) continue;

            const bucketTime = Math.floor(tradeTime / bucketMs) * bucketMs;

            if (!bucketMap.has(bucketTime)) {
                bucketMap.set(bucketTime, []);
            }
            bucketMap.get(bucketTime).push(parseFloat(trade.price));
        }

        // Convert to sorted array with closing prices
        const buckets = Array.from(bucketMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([time, prices]) => ({
                time,
                close: prices[prices.length - 1]
            }));

        // Fill gaps with last known price
        if (buckets.length < 2) return buckets;

        const filled = [];
        let lastPrice = buckets[0].close;
        let bucketIdx = 0;

        for (let t = buckets[0].time; t <= buckets[buckets.length - 1].time; t += bucketMs) {
            if (bucketIdx < buckets.length && buckets[bucketIdx].time === t) {
                filled.push(buckets[bucketIdx]);
                lastPrice = buckets[bucketIdx].close;
                bucketIdx++;
            } else {
                filled.push({ time: t, close: lastPrice });
            }
        }

        return filled;
    }

    /**
     * Calculate percent returns between consecutive buckets
     */
    calculateReturns(buckets) {
        const returns = [];

        for (let i = 1; i < buckets.length; i++) {
            const prev = buckets[i - 1].close;
            const curr = buckets[i].close;
            const returnPct = (curr - prev) / prev; // as decimal, not percent
            returns.push(returnPct);
        }

        return returns;
    }

    /**
     * Calculate IQR of returns
     */
    calculateIQR(returns) {
        const sorted = [...returns].sort((a, b) => a - b);
        const n = sorted.length;

        const q1Idx = Math.floor(n * 0.25);
        const q3Idx = Math.floor(n * 0.75);

        const q1 = sorted[q1Idx];
        const q3 = sorted[q3Idx];

        return q3 - q1;
    }

    /**
     * Fetch 1-minute candles from Coinbase (last 30 minutes)
     * Returns array of [time, low, high, open, close, volume]
     */
    async fetchCandles() {
        try {
            const end = Math.floor(Date.now() / 1000);
            const start = end - 30 * 60; // 30 minutes ago

            const url = `https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=60&start=${start}&end=${end}`;
            const response = await fetch(url);

            if (!response.ok) {
                console.warn('[Volatility] Failed to fetch candles:', response.status);
                return null;
            }

            const candles = await response.json();
            // Coinbase returns newest first, reverse for chronological order
            return candles.reverse();
        } catch (error) {
            console.error('[Volatility] Candle fetch error:', error);
            return null;
        }
    }

    /**
     * Calculate 1.5σ volatility from 1-minute candles
     * Uses log returns between consecutive candle closes
     */
    calculateCandleVolatility(candles) {
        if (!candles || candles.length < 5) return null;

        // Calculate log returns between consecutive candles
        const logReturns = [];
        for (let i = 1; i < candles.length; i++) {
            const prevClose = candles[i - 1][4]; // close is index 4
            const currClose = candles[i][4];
            if (prevClose > 0 && currClose > 0) {
                const logReturn = Math.log(currClose / prevClose);
                logReturns.push(logReturn);
            }
        }

        if (logReturns.length < 4) return null;

        // Calculate mean and standard deviation
        const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
        const squaredDiffs = logReturns.map(r => Math.pow(r - mean, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / logReturns.length;
        const stdDev = Math.sqrt(variance);

        // Use 1.5σ for slippage coverage
        const volBound = 1.5 * stdDev;

        console.log(`[Volatility] Candle stats: mean=${(mean * 100).toFixed(4)}%, σ=${(stdDev * 100).toFixed(4)}%, 1.5σ=${(volBound * 100).toFixed(4)}%`);

        return volBound;
    }

    /**
     * Calculate candle-based volatility (called alongside IQR calculation)
     */
    async calculateCandleVol() {
        try {
            const candles = await this.fetchCandles();
            if (!candles) return null;

            const vol = this.calculateCandleVolatility(candles);
            if (vol !== null) {
                this.lastCandleVol = vol;
                console.log(`[Volatility] Candle 2σ: ${(vol * 100).toFixed(4)}% (${candles.length} candles)`);
            }
            return vol;
        } catch (error) {
            console.error('[Volatility] Candle vol error:', error);
            return null;
        }
    }

    /**
     * Fetch trades from Kraken (last 4 minutes)
     * Returns array of [price, volume, timestamp, side, type, misc]
     */
    async fetchKrakenTrades() {
        try {
            // Kraken returns up to 1000 trades, newest last
            const url = 'https://api.kraken.com/0/public/Trades?pair=ETHUSD&count=1000';
            const response = await fetch(url);

            if (!response.ok) {
                console.warn('[Volatility] Failed to fetch Kraken trades:', response.status);
                return null;
            }

            const data = await response.json();
            if (data.error && data.error.length > 0) {
                console.warn('[Volatility] Kraken API error:', data.error);
                return null;
            }

            // Extract trades from result (key is XETHZUSD or similar)
            const result = data.result;
            for (const key in result) {
                if (key !== 'last' && Array.isArray(result[key])) {
                    return result[key];
                }
            }
            return null;
        } catch (error) {
            console.error('[Volatility] Kraken fetch error:', error);
            return null;
        }
    }

    /**
     * Calculate Kraken-based volatility using 15-second buckets
     * - Bucket trades into 15s intervals
     * - Calculate log returns between buckets
     * - Calculate σ of log returns
     * - Scale from 15s to 4s: σ_4s = σ_15s / √(15/4)
     * - Apply 6.5x multiplier for slippage
     */
    async calculateKrakenVol() {
        try {
            const trades = await this.fetchKrakenTrades();
            if (!trades || trades.length < 10) {
                console.warn('[Volatility] Not enough Kraken trades');
                return null;
            }

            const now = Date.now();
            const windowMs = 4 * 60 * 1000; // 4 minutes
            const bucketMs = 15000; // 15 seconds
            const cutoff = now - windowMs;

            // Filter to recent trades and extract price + timestamp
            // Kraken format: [price, volume, timestamp, side, type, misc]
            const recentTrades = trades
                .map(t => ({
                    price: parseFloat(t[0]),
                    time: parseFloat(t[2]) * 1000 // Convert to ms
                }))
                .filter(t => t.time >= cutoff)
                .sort((a, b) => a.time - b.time);

            if (recentTrades.length < 10) {
                console.warn('[Volatility] Not enough recent Kraken trades');
                return null;
            }

            // Check staleness - most recent trade must be within 2 minutes
            const mostRecentTrade = recentTrades[recentTrades.length - 1];
            const tradeAge = now - mostRecentTrade.time;
            if (tradeAge > 2 * 60 * 1000) {
                console.warn(`[Volatility] Kraken data stale - most recent trade is ${(tradeAge / 1000).toFixed(0)}s old`);
                return null;
            }

            // Create 15-second buckets
            // For each bucket timestamp, find the last trade price <= that timestamp
            const startBucket = Math.floor(recentTrades[0].time / bucketMs) * bucketMs;
            const endBucket = Math.floor(recentTrades[recentTrades.length - 1].time / bucketMs) * bucketMs;

            const buckets = [];
            let tradeIdx = 0;
            let lastPrice = recentTrades[0].price;

            for (let t = startBucket; t <= endBucket; t += bucketMs) {
                // Find last trade with time <= t + bucketMs
                while (tradeIdx < recentTrades.length && recentTrades[tradeIdx].time < t + bucketMs) {
                    lastPrice = recentTrades[tradeIdx].price;
                    tradeIdx++;
                }
                buckets.push({ time: t, price: lastPrice });
            }

            if (buckets.length < 4) {
                console.warn('[Volatility] Not enough Kraken buckets');
                return null;
            }

            // Calculate log returns
            const logReturns = [];
            for (let i = 1; i < buckets.length; i++) {
                const logReturn = Math.log(buckets[i].price / buckets[i - 1].price);
                logReturns.push(logReturn);
            }

            if (logReturns.length < 3) {
                console.warn('[Volatility] Not enough Kraken log returns');
                return null;
            }

            // Calculate standard deviation of log returns
            const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
            const squaredDiffs = logReturns.map(r => Math.pow(r - mean, 2));
            const variance = squaredDiffs.reduce((a, b) => a + b, 0) / logReturns.length;
            const sigma15s = Math.sqrt(variance);

            // Scale from 15s to settlement time: σ_t = σ_15s / √(15/t)
            const settlementTime = this.currentSettlementTime || 4;
            const scaleFactor = Math.sqrt(15 / settlementTime);
            const sigmaSettlement = sigma15s / scaleFactor;

            // Apply 6.5x multiplier for slippage (same as IQR method)
            const slippage = sigmaSettlement * 6.5;

            this.lastKrakenVol = slippage;

            console.log(`[Volatility] Kraken: σ_15s=${(sigma15s * 100).toFixed(4)}%, σ_${settlementTime}s=${(sigmaSettlement * 100).toFixed(4)}%, 6.5σ=${(slippage * 100).toFixed(4)}% (${buckets.length} buckets, ${recentTrades.length} trades)`);

            return slippage;
        } catch (error) {
            console.error('[Volatility] Kraken vol error:', error);
            return null;
        }
    }

    /**
     * Get recommended slippage: max(6.5x IQR, 1.5σ candle vol, Kraken vol)
     * Minimum 0.05%, maximum 0.5%
     */
    getRecommendedSlippage() {
        // IQR-based slippage (disabled, will be 0)
        const iqrSlippage = this.lastIQR !== null ? this.lastIQR * 6.5 * 100 : 0;

        // Candle-based slippage (1.5σ already calculated, just convert to %)
        const candleSlippage = this.lastCandleVol !== null ? this.lastCandleVol * 100 : 0;

        // Kraken-based slippage (6.5σ already calculated, just convert to %)
        const krakenSlippage = this.lastKrakenVol !== null ? this.lastKrakenVol * 100 : 0;

        // Take the max
        const rawSlippage = Math.max(iqrSlippage, candleSlippage, krakenSlippage);

        console.log(`[Volatility] Slippage: IQR=${iqrSlippage.toFixed(4)}%, Candle=${candleSlippage.toFixed(4)}%, Kraken=${krakenSlippage.toFixed(4)}%, Using=${rawSlippage.toFixed(4)}%`);

        // Default fallback if all are 0
        if (rawSlippage === 0) return 0.2;

        return Math.min(0.5, Math.max(0.05, rawSlippage));
    }

    /**
     * Add event listener
     */
    on(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    /**
     * Emit event to listeners
     */
    emit(data) {
        this.listeners.forEach(cb => cb(data));
    }
}

// Singleton instance
export const volatility = new VolatilityTracker();
