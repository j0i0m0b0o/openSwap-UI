/**
 * Gas Oracle Module
 * Calculates L1 + L2 gas costs for Optimism
 *
 * Key features:
 * - Tracks baseFee and l1BaseFee separately
 * - Uses EIP-1559 with 15% tip on baseFee
 * - Provides L1/L2 cost breakdown for debugging
 * - Low gas regime minimum for settler reward (0.001 ETH when baseFee < 20k wei)
 * - 25% spread on settler reward for safety margin
 */

// GasPriceOracle precompile address (same on OP and Base)
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';

const GAS_ORACLE_ABI = [
    'function getL1Fee(bytes calldata _data) view returns (uint256)',
    'function l1BaseFee() view returns (uint256)',
    'function baseFeeScalar() view returns (uint32)'
];

// Gas estimates for each operation (L2 execution gas)
const GAS_ESTIMATES = {
    swap: 500000n,       // createSwap
    match: 1000000n,     // matchSwap
    settle: 1200000n,    // settle (includes oracle game resolution)
    dispute: 250000n     // disputeAndSwap
};

// Mock calldata for L1 fee estimation
// swap(SwapParams, OracleParams, FulfillFeeParams) - ~708 bytes (22 fields * 32 + 4 selector)
const SWAP_CALLDATA = '0x' +
    'c15c3cd4' + // selector
    '0000000000000000000000000000000000000000000000000000000000000000'.repeat(22);

// matchSwap(uint256 swapId, bytes32 paramHashExpected) - 68 bytes
const MATCH_CALLDATA = '0x' +
    'abcd1234' + // 4 byte selector (placeholder)
    '0000000000000000000000000000000000000000000000000000000000000001' + // swapId
    '0000000000000000000000000000000000000000000000000000000000000000';  // paramHash

// settle(uint256 reportId) - 36 bytes
const SETTLE_CALLDATA = '0x' +
    'abcd1234' + // 4 byte selector
    '0000000000000000000000000000000000000000000000000000000000000001';  // reportId

// disputeAndSwap(uint256, address, uint256, uint256, uint256, bytes32) - 196 bytes
const DISPUTE_CALLDATA = '0x' +
    'abcd1234' + // 4 byte selector
    '0000000000000000000000000000000000000000000000000000000000000001' + // reportId
    '0000000000000000000000000000000000000000000000000000000000000000' + // tokenToSwap
    '0000000000000000000000000000000000000000000000000000000000000001' + // newAmount1
    '0000000000000000000000000000000000000000000000000000000000000001' + // newAmount2
    '0000000000000000000000000000000000000000000000000000000000000001' + // amt2Expected
    '0000000000000000000000000000000000000000000000000000000000000000';  // stateHash

// Config
const TIP_PERCENTAGE = 15n;  // 15% tip on baseFee for priority
const SETTLER_SPREAD = 25n;  // 25% spread on settler reward for safety
const LOW_GAS_THRESHOLD = 20000n;  // 20k wei - below this is "low gas regime"
const LOW_GAS_FLOOR_SETTLER = BigInt(1e5);  // 0.0001 gwei = 100,000 wei - floor for settler reward
const LOW_GAS_FLOOR_INIT_LIQ = BigInt(5e5);  // 0.0005 gwei = 500,000 wei - floor for initial liquidity

// Backup RPCs for Optimism (used if primary provider fails)
const BACKUP_RPCS = [
    'https://optimism.llamarpc.com',
    'https://1rpc.io/op'
];

class GasOracle {
    constructor() {
        // Raw fee data from chain
        this.baseFee = null;
        this.l1BaseFee = null;
        this.baseFeeScalar = null;

        // L1 fees from precompile (direct call)
        this.l1Fees = {
            swap: null,
            match: null,
            settle: null,
            dispute: null
        };

        // 10th percentile tip from fee history (for worst-case init liq calculation)
        this.tip10thPercentile = null;

        this.lastUpdate = 0;
        this.updateInterval = 10000; // 10 seconds (more frequent for accuracy)
        this.updating = false;
    }

    /**
     * Get or create contract instance
     */
    getContract(provider) {
        return new ethers.Contract(GAS_PRICE_ORACLE, GAS_ORACLE_ABI, provider);
    }

    /**
     * Fetch fee history to get 10th percentile tip (avg of last 4 blocks)
     */
    async fetchFeeHistory(provider) {
        try {
            const feeHistory = await provider.send('eth_feeHistory', ['0x4', 'latest', [10]]);
            if (feeHistory && feeHistory.reward && feeHistory.reward.length > 0) {
                // Average the 10th percentile tips from last 4 blocks
                const tips = feeHistory.reward.map(r => BigInt(r[0]));
                const avgTip = tips.reduce((a, b) => a + b, BigInt(0)) / BigInt(tips.length);
                this.tip10thPercentile = avgTip;
                console.log(`[GasOracle] 10th percentile tip: ${avgTip} wei (${Number(avgTip) / 1e9} gwei)`);
                return avgTip;
            }
        } catch (e) {
            console.warn('[GasOracle] Failed to fetch fee history:', e.message);
        }
        return null;
    }

    /**
     * Update all gas parameters
     * Tries primary provider first, then falls back to backup RPCs
     */
    async update(provider, force = false) {
        if (!provider) return;
        if (this.updating) return;

        const now = Date.now();
        if (!force && this.lastUpdate && now - this.lastUpdate < this.updateInterval) return;

        this.updating = true;

        // Build list of providers to try: primary first, then backups
        const providers = [provider];
        for (const rpcUrl of BACKUP_RPCS) {
            try {
                providers.push(new ethers.JsonRpcProvider(rpcUrl));
            } catch (e) {
                // Ignore invalid RPC URLs
            }
        }

        let lastError = null;
        for (let i = 0; i < providers.length; i++) {
            const p = providers[i];
            try {
                const contract = this.getContract(p);

                // Fetch all parameters in parallel
                // L2 baseFee comes from the latest block, not the precompile
                const [block, l1BaseFee, baseFeeScalar, swapL1, matchL1, settleL1, disputeL1, _feeHistory] = await Promise.all([
                    p.getBlock('latest'),
                    contract.l1BaseFee(),
                    contract.baseFeeScalar(),
                    contract.getL1Fee(SWAP_CALLDATA),
                    contract.getL1Fee(MATCH_CALLDATA),
                    contract.getL1Fee(SETTLE_CALLDATA),
                    contract.getL1Fee(DISPUTE_CALLDATA),
                    this.fetchFeeHistory(p)
                ]);

                // L2 baseFee from the block
                this.baseFee = block?.baseFeePerGas || BigInt(0);
                this.l1BaseFee = l1BaseFee;
                this.baseFeeScalar = baseFeeScalar;
                this.l1Fees.swap = swapL1;
                this.l1Fees.match = matchL1;
                this.l1Fees.settle = settleL1;
                this.l1Fees.dispute = disputeL1;
                this.lastUpdate = now;

                console.log('[GasOracle] Updated:', {
                    baseFee: `${this.baseFee} wei (${Number(this.baseFee) / 1e9} gwei)`,
                    l1BaseFee: `${l1BaseFee} wei (${Number(l1BaseFee) / 1e9} gwei)`,
                    baseFeeScalar: baseFeeScalar.toString(),
                    l1Fees: {
                        swap: `${ethers.formatEther(swapL1)} ETH`,
                        match: `${ethers.formatEther(matchL1)} ETH`,
                        settle: `${ethers.formatEther(settleL1)} ETH`,
                        dispute: `${ethers.formatEther(disputeL1)} ETH`
                    },
                    provider: i === 0 ? 'primary' : `backup-${i}`
                });

                this.updating = false;
                return; // Success, exit
            } catch (e) {
                lastError = e;
                if (i < providers.length - 1) {
                    console.warn(`[GasOracle] Provider ${i} failed, trying backup...`);
                }
            }
        }

        // All providers failed
        console.error('[GasOracle] All providers failed:', lastError);
        this.updating = false;
    }

    /**
     * Get effective gas price (baseFee + 15% tip)
     */
    getEffectiveGasPrice() {
        if (!this.baseFee) return BigInt(0);
        return this.baseFee + (this.baseFee * TIP_PERCENTAGE / 100n);
    }

    /**
     * Check if we're in low gas regime (baseFee < 20k wei)
     */
    isLowGasRegime() {
        return this.baseFee !== null && this.baseFee < LOW_GAS_THRESHOLD;
    }

    /**
     * Get cost breakdown for an operation
     * @param {string} operation - 'match', 'settle', or 'dispute'
     * @returns {object} - { l2Cost, l1Cost, total, effectiveGasPrice }
     */
    getCostBreakdown(operation) {
        const gasUsed = GAS_ESTIMATES[operation];
        const effectiveGasPrice = this.getEffectiveGasPrice();
        const l2Cost = gasUsed * effectiveGasPrice;
        const l1Cost = this.l1Fees[operation] || BigInt(0);
        const total = l2Cost + l1Cost;

        return {
            l2Cost,
            l1Cost,
            total,
            effectiveGasPrice,
            gasUsed
        };
    }

    /**
     * Get total cost for swap creation
     * L2: 500k gas * effectiveGasPrice
     * L1: from precompile
     */
    getSwapCost() {
        const breakdown = this.getCostBreakdown('swap');
        return breakdown.total;
    }

    /**
     * Get swap cost with L1/L2 breakdown
     */
    getSwapCostBreakdown() {
        return this.getCostBreakdown('swap');
    }

    /**
     * Get total cost for matchSwap (gasCompensation)
     * L2: 1M gas * effectiveGasPrice
     * L1: from precompile
     * + 25% spread for safety margin
     */
    getMatchCost() {
        const breakdown = this.getCostBreakdown('match');
        const withSpread = breakdown.total + (breakdown.total * SETTLER_SPREAD / 100n);
        return withSpread;
    }

    /**
     * Get match cost with L1/L2 breakdown
     */
    getMatchCostBreakdown() {
        return this.getCostBreakdown('match');
    }

    /**
     * Get total cost for settle (settlerReward)
     * L2: 1.2M gas * effectiveGasPrice
     * L1: from precompile
     * + 25% spread for safety margin
     *
     * In low gas regime (baseFee < 20k wei), floor baseFee at 0.0001 gwei
     */
    getSettleCost() {
        const isLowGas = this.isLowGasRegime();
        let l2Cost, effectivePrice;

        if (isLowGas) {
            // Floor baseFee in low gas regime
            const flooredBaseFee = this.baseFee < LOW_GAS_FLOOR_SETTLER ? LOW_GAS_FLOOR_SETTLER : this.baseFee;
            effectivePrice = flooredBaseFee + (flooredBaseFee * TIP_PERCENTAGE / 100n);
            l2Cost = GAS_ESTIMATES.settle * effectivePrice;
        } else {
            effectivePrice = this.getEffectiveGasPrice();
            l2Cost = GAS_ESTIMATES.settle * effectivePrice;
        }

        const l1Cost = this.l1Fees.settle || BigInt(0);
        const baseCost = l2Cost + l1Cost;

        // Apply 25% spread
        const withSpread = baseCost + (baseCost * SETTLER_SPREAD / 100n);
        return withSpread;
    }

    /**
     * Get settle cost with full breakdown
     */
    getSettleCostBreakdown() {
        const isLowGas = this.isLowGasRegime();
        const actualBreakdown = this.getCostBreakdown('settle');
        let l2Cost, effectivePrice, flooredBaseFee;

        if (isLowGas) {
            // Floor baseFee in low gas regime
            flooredBaseFee = this.baseFee < LOW_GAS_FLOOR_SETTLER ? LOW_GAS_FLOOR_SETTLER : this.baseFee;
            effectivePrice = flooredBaseFee + (flooredBaseFee * TIP_PERCENTAGE / 100n);
            l2Cost = GAS_ESTIMATES.settle * effectivePrice;
        } else {
            effectivePrice = this.getEffectiveGasPrice();
            l2Cost = GAS_ESTIMATES.settle * effectivePrice;
        }

        const l1Cost = this.l1Fees.settle || BigInt(0);
        const baseCost = l2Cost + l1Cost;
        const withSpread = baseCost + (baseCost * SETTLER_SPREAD / 100n);

        return {
            ...actualBreakdown,
            isLowGasRegime: isLowGas,
            flooredBaseFee: isLowGas ? flooredBaseFee : null,
            flooredEffectivePrice: isLowGas ? effectivePrice : null,
            flooredL2Cost: isLowGas ? l2Cost : null,
            baseCost,
            spreadPercent: Number(SETTLER_SPREAD),
            withSpread,
            final: withSpread
        };
    }

    /**
     * Get total cost for dispute (used for initial liquidity floor)
     * L2: 250k gas * effectiveGasPrice
     * L1: from precompile
     */
    getDisputeCost() {
        const breakdown = this.getCostBreakdown('dispute');
        return breakdown.total;
    }

    /**
     * Get dispute cost with breakdown
     */
    getDisputeCostBreakdown() {
        return this.getCostBreakdown('dispute');
    }

    /**
     * Get dispute cost for initial liquidity floor calculation
     * Uses max(10th percentile tip, 15% of baseFee) for worst-case gas estimate
     * In low gas regime, clamps baseFee to 0.0005 gwei floor
     */
    getDisputeCostForInitLiq() {
        const isLowGas = this.isLowGasRegime();
        const baseToUse = isLowGas
            ? (this.baseFee < LOW_GAS_FLOOR_INIT_LIQ ? LOW_GAS_FLOOR_INIT_LIQ : this.baseFee)
            : this.baseFee;

        // Use max(10th percentile tip, 15% of baseFee) for worst-case
        const percentTip = baseToUse * TIP_PERCENTAGE / 100n;
        const tip10th = this.tip10thPercentile || BigInt(0);
        const tipToUse = tip10th > percentTip ? tip10th : percentTip;

        const effectivePrice = baseToUse + tipToUse;
        const l2Cost = GAS_ESTIMATES.dispute * effectivePrice;
        const l1Cost = this.l1Fees.dispute || BigInt(0);
        return l2Cost + l1Cost;
    }

    /**
     * Get dispute cost for init liq with full breakdown
     */
    getDisputeCostForInitLiqBreakdown() {
        const isLowGas = this.isLowGasRegime();
        const actualBreakdown = this.getCostBreakdown('dispute');
        const baseToUse = isLowGas
            ? (this.baseFee < LOW_GAS_FLOOR_INIT_LIQ ? LOW_GAS_FLOOR_INIT_LIQ : this.baseFee)
            : this.baseFee;

        // Use max(10th percentile tip, 15% of baseFee) for worst-case
        const percentTip = baseToUse * TIP_PERCENTAGE / 100n;
        const tip10th = this.tip10thPercentile || BigInt(0);
        const tipToUse = tip10th > percentTip ? tip10th : percentTip;

        const effectivePrice = baseToUse + tipToUse;
        const l2Cost = GAS_ESTIMATES.dispute * effectivePrice;
        const l1Cost = this.l1Fees.dispute || BigInt(0);
        const total = l2Cost + l1Cost;

        return {
            ...actualBreakdown,
            isLowGasRegime: isLowGas,
            baseToUse,
            tip10thPercentile: tip10th,
            percentTip,
            tipUsed: tipToUse,
            effectivePrice,
            l2Cost,
            final: total
        };
    }

    /**
     * Get raw gas parameters for debugging
     */
    getRawParams() {
        return {
            baseFee: this.baseFee,
            baseFeeGwei: this.baseFee ? Number(this.baseFee) / 1e9 : null,
            l1BaseFee: this.l1BaseFee,
            l1BaseFeeGwei: this.l1BaseFee ? Number(this.l1BaseFee) / 1e9 : null,
            baseFeeScalar: this.baseFeeScalar,
            effectiveGasPrice: this.getEffectiveGasPrice(),
            effectiveGasPriceGwei: this.baseFee ? Number(this.getEffectiveGasPrice()) / 1e9 : null,
            isLowGasRegime: this.isLowGasRegime(),
            tipPercentage: Number(TIP_PERCENTAGE),
            settlerSpread: Number(SETTLER_SPREAD)
        };
    }

    /**
     * Check if L1 fees are available
     */
    isReady() {
        return this.baseFee !== null && this.l1Fees.match !== null;
    }
}

// Singleton instance
export const gasOracle = new GasOracle();
