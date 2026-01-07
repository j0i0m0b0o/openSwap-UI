/**
 * Token List - ETH and USDC only
 * USDC address is read dynamically from CONFIG to support network switching
 */

import { CONFIG } from './config.js';

export const ETH = {
    address: '0x0000000000000000000000000000000000000000',
    symbol: 'ETH',
    name: 'Ethereum',
    decimals: 18,
    logo: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
    isNative: true
};

// USDC with dynamic address getter
export const USDC = {
    get address() { return CONFIG.tokens.USDC; },
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    logo: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png'
};

export const TOKENS = [ETH, USDC];

/**
 * Find token by address (checks dynamically)
 */
export function getToken(address) {
    if (!address) return null;
    const addr = address.toLowerCase();
    if (addr === ETH.address.toLowerCase()) return ETH;
    if (addr === USDC.address.toLowerCase()) return USDC;
    return null;
}

/**
 * Format token amount with decimals
 */
export function formatTokenAmount(amount, decimals, maxDecimals = 6) {
    if (!amount) return '0';
    const num = parseFloat(amount) / Math.pow(10, decimals);
    if (num === 0) return '0';
    if (num < 0.000001) return '<0.000001';

    let decimalPlaces = maxDecimals;
    if (num >= 1000) decimalPlaces = 2;
    else if (num >= 100) decimalPlaces = 3;
    else if (num >= 1) decimalPlaces = 4;

    return num.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimalPlaces
    });
}

/**
 * Parse token amount to wei
 */
export function parseTokenAmount(amount, decimals) {
    if (!amount || isNaN(parseFloat(amount))) return BigInt(0);
    const [whole, fraction = ''] = amount.toString().split('.');
    const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
    return BigInt(whole + paddedFraction);
}

/**
 * Format address for display
 */
export function formatAddress(address) {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
