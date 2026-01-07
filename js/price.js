/**
 * Coinbase WebSocket Price Feed
 * Real-time ETH/USD mid price
 */

class PriceFeed {
    constructor() {
        this.ws = null;
        this.price = null;
        this.bid = null;
        this.ask = null;
        this.listeners = new Set();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.isConnected = false;
    }

    /**
     * Connect to Coinbase WebSocket
     */
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }

        try {
            this.ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');

            this.ws.onopen = () => {
                console.log('Coinbase WebSocket connected');
                this.isConnected = true;
                this.reconnectAttempts = 0;

                // Subscribe to ETH-USD ticker
                this.ws.send(JSON.stringify({
                    type: 'subscribe',
                    product_ids: ['ETH-USD'],
                    channels: ['ticker']
                }));

                this.emit('connected');
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);

                    if (data.type === 'ticker' && data.product_id === 'ETH-USD') {
                        this.bid = parseFloat(data.best_bid);
                        this.ask = parseFloat(data.best_ask);
                        this.price = (this.bid + this.ask) / 2;

                        this.emit('price', {
                            price: this.price,
                            bid: this.bid,
                            ask: this.ask,
                            timestamp: new Date(data.time).getTime()
                        });
                    }
                } catch (e) {
                    console.error('Failed to parse WebSocket message:', e);
                }
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.emit('error', error);
            };

            this.ws.onclose = () => {
                console.log('WebSocket closed');
                this.isConnected = false;
                this.emit('disconnected');
                this.attemptReconnect();
            };

        } catch (error) {
            console.error('Failed to connect to WebSocket:', error);
            this.attemptReconnect();
        }
    }

    /**
     * Attempt to reconnect
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Max reconnection attempts reached');
            this.emit('maxReconnectFailed');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        setTimeout(() => {
            this.connect();
        }, delay);
    }

    /**
     * Disconnect WebSocket
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
    }

    /**
     * Get current mid price
     */
    getPrice() {
        return this.price;
    }

    /**
     * Get bid/ask spread
     */
    getSpread() {
        if (!this.bid || !this.ask) return null;
        return {
            bid: this.bid,
            ask: this.ask,
            spread: this.ask - this.bid,
            spreadPercent: ((this.ask - this.bid) / this.price) * 100
        };
    }

    /**
     * Calculate USDC amount for given ETH amount
     */
    ethToUsdc(ethAmount) {
        if (!this.price || !ethAmount) return null;
        return parseFloat(ethAmount) * this.price;
    }

    /**
     * Calculate ETH amount for given USDC amount
     */
    usdcToEth(usdcAmount) {
        if (!this.price || !usdcAmount) return null;
        return parseFloat(usdcAmount) / this.price;
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
    emit(event, data = {}) {
        this.listeners.forEach(callback => callback({ event, ...data }));
    }
}

// Singleton instance
export const priceFeed = new PriceFeed();
