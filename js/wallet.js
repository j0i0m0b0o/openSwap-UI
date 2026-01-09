/**
 * Wallet Connection Module
 * Handles wallet connections and network management
 */

import { CONFIG, ERC20_ABI } from './config.js';

class WalletManager {
    constructor() {
        this.provider = null;
        this.signer = null;
        this.address = null;
        this.chainId = null;
        this.listeners = new Set();
    }

    /**
     * Check if wallet is available
     */
    isAvailable() {
        return typeof window.ethereum !== 'undefined';
    }

    /**
     * Connect to wallet
     */
    async connect() {
        if (!this.isAvailable()) {
            throw new Error('No wallet found. Please install MetaMask or another Web3 wallet.');
        }

        try {
            // Request accounts
            const accounts = await window.ethereum.request({
                method: 'eth_requestAccounts'
            });

            if (accounts.length === 0) {
                throw new Error('No accounts found');
            }

            // Create provider and signer
            this.provider = new ethers.BrowserProvider(window.ethereum);
            this.signer = await this.provider.getSigner();
            this.address = accounts[0];

            // Get chain ID
            const network = await this.provider.getNetwork();
            this.chainId = Number(network.chainId);

            // Switch to configured network if needed
            if (this.chainId !== CONFIG.chainId) {
                await this.switchNetwork(CONFIG.chainId);
            }

            // Set up event listeners
            this.setupListeners();

            // Notify listeners
            this.emit('connect', { address: this.address, chainId: this.chainId });

            return {
                address: this.address,
                chainId: this.chainId
            };
        } catch (error) {
            console.error('Wallet connection error:', error);
            throw error;
        }
    }

    /**
     * Disconnect wallet
     */
    disconnect() {
        this.provider = null;
        this.signer = null;
        this.address = null;
        this.chainId = null;
        this.emit('disconnect');
    }

    /**
     * Switch to a specific network by chainId
     */
    async switchNetwork(chainId) {
        const chainIdHex = `0x${chainId.toString(16)}`;
        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: chainIdHex }]
            });
        } catch (switchError) {
            // Chain not added, try to add it
            if (switchError.code === 4902) {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: chainIdHex,
                        chainName: CONFIG.chainName,
                        nativeCurrency: {
                            name: 'Ethereum',
                            symbol: 'ETH',
                            decimals: 18
                        },
                        rpcUrls: [CONFIG.rpcUrl],
                        blockExplorerUrls: [CONFIG.blockExplorer]
                    }]
                });
            } else {
                throw switchError;
            }
        }

        // Recreate provider after network switch (old one is stale)
        this.provider = new ethers.BrowserProvider(window.ethereum);
        this.signer = await this.provider.getSigner();
        const network = await this.provider.getNetwork();
        this.chainId = Number(network.chainId);
    }

    /**
     * Switch to configured network (backwards compat)
     */
    async switchToOptimism() {
        return this.switchNetwork(CONFIG.chainId);
    }

    /**
     * Get ETH balance
     */
    async getBalance() {
        if (!this.provider || !this.address) return BigInt(0);
        return await this.provider.getBalance(this.address);
    }

    /**
     * Get token balance via direct RPC call (bypasses MetaMask caching)
     * @param {string} tokenAddress - Token contract address (zero address for ETH)
     * @param {string} blockTag - Optional block tag: "latest", "pending", or block number
     */
    async getTokenBalance(tokenAddress, blockTag = 'latest') {
        if (!this.address) return BigInt(0);

        try {
            // Use direct RPC call to bypass MetaMask caching
            if (tokenAddress === '0x0000000000000000000000000000000000000000') {
                // Native ETH balance
                const result = await this.rpcCall('eth_getBalance', [this.address, blockTag]);
                return BigInt(result);
            } else {
                // ERC20 balanceOf call
                // balanceOf(address) selector = 0x70a08231
                const data = '0x70a08231' + this.address.slice(2).padStart(64, '0');
                const result = await this.rpcCall('eth_call', [
                    { to: tokenAddress, data },
                    blockTag
                ]);
                return BigInt(result);
            }
        } catch (e) {
            console.error('[Wallet] Direct RPC balance fetch failed, falling back to provider:', e);
            // Fallback to provider
            if (!this.provider) return BigInt(0);
            if (tokenAddress === '0x0000000000000000000000000000000000000000') {
                return await this.provider.getBalance(this.address, blockTag);
            }
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
            return await contract.balanceOf(this.address, { blockTag });
        }
    }

    /**
     * Direct RPC call to configured network
     */
    async rpcCall(method, params = []) {
        const response = await fetch(CONFIG.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method,
                params,
                id: Date.now()
            })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);
        return data.result;
    }

    /**
     * Get token allowance
     */
    async getAllowance(tokenAddress, spenderAddress) {
        if (!this.provider || !this.address) return BigInt(0);
        if (tokenAddress === '0x0000000000000000000000000000000000000000') {
            return ethers.MaxUint256; // Native ETH doesn't need approval
        }

        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
        return await contract.allowance(this.address, spenderAddress);
    }

    /**
     * Approve token spending
     */
    async approve(tokenAddress, spenderAddress, amount) {
        if (!this.signer) throw new Error('Wallet not connected');
        if (!amount) throw new Error('Approval amount required');

        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.signer);
        const tx = await contract.approve(spenderAddress, amount);
        return await tx.wait();
    }

    /**
     * Set up wallet event listeners
     */
    setupListeners() {
        if (!window.ethereum) return;

        window.ethereum.on('accountsChanged', async (accounts) => {
            if (accounts.length === 0) {
                this.disconnect();
            } else {
                this.address = accounts[0];
                // Refresh provider and signer for new account
                this.provider = new ethers.BrowserProvider(window.ethereum);
                this.signer = await this.provider.getSigner();
                this.emit('accountsChanged', { address: this.address });
            }
        });

        window.ethereum.on('chainChanged', async (chainIdHex) => {
            this.chainId = parseInt(chainIdHex, 16);
            this.emit('chainChanged', { chainId: this.chainId });

            // Refresh provider
            if (this.isConnected()) {
                this.provider = new ethers.BrowserProvider(window.ethereum);
                this.signer = await this.provider.getSigner();
            }
        });
    }

    /**
     * Check if connected
     */
    isConnected() {
        return this.address !== null && this.provider !== null;
    }

    /**
     * Check if on correct network
     */
    isCorrectNetwork() {
        return this.chainId === CONFIG.chainId;
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

    /**
     * Format address for display
     */
    formatAddress(address = this.address) {
        if (!address) return '';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }
}

// Singleton instance
export const wallet = new WalletManager();
