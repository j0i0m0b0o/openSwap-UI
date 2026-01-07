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
     * Get token balance
     */
    async getTokenBalance(tokenAddress) {
        if (!this.provider || !this.address) return BigInt(0);

        // Native ETH
        if (tokenAddress === '0x0000000000000000000000000000000000000000') {
            return await this.getBalance();
        }

        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
        return await contract.balanceOf(this.address);
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
