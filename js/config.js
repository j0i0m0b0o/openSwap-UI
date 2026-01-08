/**
 * openSwap Configuration
 * Multi-network support for Base and Optimism
 */

export const NETWORKS = {
    base: {
        chainId: 8453,
        chainName: 'Base',
        rpcUrl: 'https://mainnet.base.org',
        blockExplorer: 'https://basescan.org',
        contracts: {
            openSwap: '0x4Ac9F8b7A78b6Ae24D1bd07Aa59D1311695EbAf7',
            openOracle: '0x7caE6CCBd545Ad08f0Ea1105A978FEBBE2d1a752',
            oracleBounty: '0x0000000000000000000000000000000000000000',
        },
        weth: '0x4200000000000000000000000000000000000006',
        tokens: {
            USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        },
    },
    optimism: {
        chainId: 10,
        chainName: 'Optimism',
        rpcUrl: 'https://mainnet.optimism.io',
        blockExplorer: 'https://optimistic.etherscan.io',
        contracts: {
            openSwap: '0xd3E9288779132fD5fbcf5b2b5476399eC8154caC',
            openOracle: '0xf3CCE3274c32f1F344Ba48336D5EFF34dc6E145f',
            oracleBounty: '0x971F2EE9a8ccDc455fd39403788C75bfd58dA321',
        },
        weth: '0x4200000000000000000000000000000000000006',
        tokens: {
            USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
        },
    },
};

// Shared defaults across networks
const DEFAULTS = {
    settlementTime: 4, // 4 seconds
    disputeDelay: 1, // 1 second delay
    swapFee: 1, // 0.00001%
    protocolFee: 250, // 0.0025%
    settlerRewardGas: 1200000, // 1.2M gas worth of ETH
    gasCompensationGas: 900000, // 900k gas worth of ETH
    latencyBailout: 30, // 30 seconds
    maxGameTime: 1800, // 30 minutes
    // Fulfillment fee params
    startingFee: 750, // 0.0075%
    maxFee: 2000, // 0.02%
    growthRate: 12000, // 1.2x per round
    maxRounds: 6,
    roundLength: 1, // 1 second
};

// Default to Optimism
export let CONFIG = {
    ...NETWORKS.optimism,
    defaults: DEFAULTS
};

// Helper to get network config by chainId
export function getNetworkByChainId(chainId) {
    return Object.values(NETWORKS).find(n => n.chainId === chainId);
}

// Helper to switch active config
export function setNetwork(networkKey) {
    const network = NETWORKS[networkKey];
    if (network) {
        Object.assign(CONFIG, network);
    }
}

// openSwap ABI - loaded from JSON file
import OPENSWAP_ABI_JSON from '../openSwapABI.json' with { type: 'json' };
export const OPENSWAP_ABI = OPENSWAP_ABI_JSON;

// ERC20 ABI
export const ERC20_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event Approval(address indexed owner, address indexed spender, uint256 value)"
];
