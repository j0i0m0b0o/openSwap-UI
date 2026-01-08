/**
 * Price Validator Module
 * Fetches ETH/USD prices from multiple sources and validates against Coinbase mid
 * Sources: Bitstamp, Pyth, Kraken, Gemini
 */

import { priceFeed } from './price.js';

class PriceValidator {
    constructor() {
        this.prices = {
            bitstamp: null,
            pyth: null,
            kraken: null,
            gemini: null
        };
        this.lastUpdate = {
            bitstamp: 0,
            pyth: 0,
            kraken: 0,
            gemini: 0
        };
        this.isValid = true;
        this.listeners = new Set();
        this.updateInterval = null;
        this.tolerance = 0.01; // 1% tolerance
    }

    /**
     * Start the price validator
     */
    start() {
        // Initial fetch
        this.fetchAllPrices();

        // Refresh every 4 seconds
        this.updateInterval = setInterval(() => {
            this.fetchAllPrices();
        }, 4000);
    }

    /**
     * Stop the validator
     */
    stop() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    /**
     * Fetch prices from all sources in parallel
     */
    async fetchAllPrices() {
        await Promise.allSettled([
            this.fetchBitstamp(),
            this.fetchPyth(),
            this.fetchKraken(),
            this.fetchGemini()
        ]);

        this.validate();
    }

    /**
     * Fetch from Bitstamp
     */
    async fetchBitstamp() {
        try {
            const response = await fetch(
                'https://www.bitstamp.net/api/v2/ticker/ethusd/',
                { signal: AbortSignal.timeout(3000) }
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.bid && data.ask) {
                const bid = parseFloat(data.bid);
                const ask = parseFloat(data.ask);
                this.prices.bitstamp = (bid + ask) / 2;
                this.lastUpdate.bitstamp = Date.now();
                console.log('[PriceValidator] Bitstamp:', this.prices.bitstamp.toFixed(2));
            }
        } catch (e) {
            console.warn('[PriceValidator] Bitstamp fetch failed:', e.message);
        }
    }

    /**
     * Fetch from Pyth Network (via Hermes)
     * ETH/USD price feed ID: 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
     */
    async fetchPyth() {
        try {
            const feedId = '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';
            const response = await fetch(
                `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`,
                { signal: AbortSignal.timeout(3000) }
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.parsed?.[0]?.price) {
                const priceData = data.parsed[0].price;
                // Price is in format: price * 10^expo
                const price = Number(priceData.price) * Math.pow(10, priceData.expo);
                this.prices.pyth = price;
                this.lastUpdate.pyth = Date.now();
                console.log('[PriceValidator] Pyth:', this.prices.pyth.toFixed(2));
            }
        } catch (e) {
            console.warn('[PriceValidator] Pyth fetch failed:', e.message);
        }
    }

    /**
     * Fetch from Kraken
     */
    async fetchKraken() {
        try {
            const response = await fetch(
                'https://api.kraken.com/0/public/Ticker?pair=ETHUSD',
                { signal: AbortSignal.timeout(3000) }
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.result?.XETHZUSD) {
                // Use last trade price (c[0]) or mid of bid/ask
                const ticker = data.result.XETHZUSD;
                const bid = parseFloat(ticker.b[0]);
                const ask = parseFloat(ticker.a[0]);
                this.prices.kraken = (bid + ask) / 2;
                this.lastUpdate.kraken = Date.now();
                console.log('[PriceValidator] Kraken:', this.prices.kraken.toFixed(2));
            }
        } catch (e) {
            console.warn('[PriceValidator] Kraken fetch failed:', e.message);
        }
    }

    /**
     * Fetch from Gemini (ETH/USD)
     */
    async fetchGemini() {
        try {
            const response = await fetch(
                'https://api.gemini.com/v1/pubticker/ethusd',
                { signal: AbortSignal.timeout(3000) }
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.bid && data.ask) {
                const bid = parseFloat(data.bid);
                const ask = parseFloat(data.ask);
                this.prices.gemini = (bid + ask) / 2;
                this.lastUpdate.gemini = Date.now();
                console.log('[PriceValidator] Gemini:', this.prices.gemini.toFixed(2));
            }
        } catch (e) {
            console.warn('[PriceValidator] Gemini fetch failed:', e.message);
        }
    }

    /**
     * Validate Coinbase price against other sources
     * Requires 3 of 4 sources to be within 1% of Coinbase mid
     */
    validate() {
        const coinbasePrice = priceFeed.getPrice();
        if (!coinbasePrice) {
            // No Coinbase price yet, skip validation (keep valid state until we can compare)
            return;
        }

        // Get valid prices (updated within last 30 seconds)
        const now = Date.now();
        const maxAge = 30000;
        const validPrices = [];

        for (const [source, price] of Object.entries(this.prices)) {
            if (price && (now - this.lastUpdate[source]) < maxAge) {
                validPrices.push({ source, price });
            }
        }

        if (validPrices.length < 3) {
            // Not enough sources, allow trading but log warning
            console.warn('[PriceValidator] Only', validPrices.length, 'price sources available');
            this.isValid = true;
            this.emit('valid', { sources: validPrices.length, warning: 'Limited sources' });
            return;
        }

        // Find tightest 3 prices (closest to each other)
        const tightest3 = this.findTightest3(validPrices);

        // Check if Coinbase is within 1% of each of the tightest 3
        let agreementCount = 0;
        const deviations = [];

        for (const { source, price } of tightest3) {
            const deviation = Math.abs(coinbasePrice - price) / price;
            deviations.push({ source, price, deviation: (deviation * 100).toFixed(3) + '%' });
            if (deviation <= this.tolerance) {
                agreementCount++;
            }
        }

        const wasValid = this.isValid;
        this.isValid = agreementCount >= 3;

        // Log validation summary
        console.log(`[PriceValidator] Coinbase: ${coinbasePrice.toFixed(2)} | Valid: ${this.isValid} (${agreementCount}/3 agree)`);

        if (this.isValid) {
            this.emit('valid', { sources: validPrices.length, deviations });
        } else {
            this.emit('invalid', {
                reason: 'Price deviation',
                coinbasePrice,
                deviations,
                agreementCount
            });
        }

        // Log status change
        if (wasValid !== this.isValid) {
            console.log('[PriceValidator] Status changed:', this.isValid ? 'VALID' : 'INVALID', deviations);
        }
    }

    /**
     * Find the 3 prices that are closest to each other
     */
    findTightest3(prices) {
        if (prices.length <= 3) return prices;

        // Sort by price
        const sorted = [...prices].sort((a, b) => a.price - b.price);

        // Find the window of 3 with smallest range
        let minRange = Infinity;
        let tightest = sorted.slice(0, 3);

        for (let i = 0; i <= sorted.length - 3; i++) {
            const range = sorted[i + 2].price - sorted[i].price;
            if (range < minRange) {
                minRange = range;
                tightest = sorted.slice(i, i + 3);
            }
        }

        return tightest;
    }

    /**
     * Get current validation status
     */
    getStatus() {
        return {
            isValid: this.isValid,
            prices: { ...this.prices },
            coinbasePrice: priceFeed.getPrice(),
            lastUpdate: { ...this.lastUpdate }
        };
    }

    /**
     * Add event listener
     */
    on(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    /**
     * Emit event
     */
    emit(event, data = {}) {
        this.listeners.forEach(callback => callback({ event, ...data }));
    }
}

// Singleton instance
export const priceValidator = new PriceValidator();
