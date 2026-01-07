/**
 * Contract Interaction Module
 * Handles all openSwap contract interactions
 */

import { CONFIG, OPENSWAP_ABI, ERC20_ABI } from './config.js';
import { wallet } from './wallet.js';
import { parseTokenAmount } from './tokens.js';

// Oracle ABI for reportStatus and settle
// ReportStatus struct order: currentAmount1, currentAmount2, price, currentReporter, reportTimestamp, settlementTimestamp, initialReporter, lastReportOppoTime, disputeOccurred, isDistributed
const ORACLE_ABI = [
    "function reportStatus(uint256 reportId) view returns (uint256 currentAmount1, uint256 currentAmount2, uint256 price, address currentReporter, uint48 reportTimestamp, uint48 settlementTimestamp, address initialReporter, uint48 lastReportOppoTime, bool disputeOccurred, bool isDistributed)",
    "function settle(uint256 reportId) returns (uint256 price, uint256 settlementTimestamp)"
];

class OpenSwapContract {
    constructor() {
        this.address = CONFIG.contracts.openSwap;
    }

    /**
     * Get contract instance
     */
    getContract(useSigner = false) {
        const providerOrSigner = useSigner ? wallet.signer : wallet.provider;
        if (!providerOrSigner) {
            throw new Error('Wallet not connected');
        }
        return new ethers.Contract(this.address, OPENSWAP_ABI, providerOrSigner);
    }

    /**
     * Get the next swap ID
     */
    async getNextSwapId() {
        const contract = this.getContract();
        return await contract.nextSwapId();
    }

    /**
     * Get swap details by ID
     */
    async getSwap(swapId) {
        const contract = this.getContract();
        const s = await contract.getSwap(swapId);

        // Convert ethers Result to plain object
        return {
            sellAmt: s.sellAmt,
            minOut: s.minOut,
            minFulfillLiquidity: s.minFulfillLiquidity,
            expiration: s.expiration,
            reportId: s.reportId,
            gasCompensation: s.gasCompensation,
            start: s.start,
            fulfillmentFee: s.fulfillmentFee,
            sellToken: s.sellToken,
            buyToken: s.buyToken,
            swapper: s.swapper,
            matcher: s.matcher,
            feeRecipient: s.feeRecipient,
            active: s.active,
            matched: s.matched,
            finished: s.finished,
            cancelled: s.cancelled,
            bountyParams: s.bountyParams ? {
                totalAmtDeposited: s.bountyParams.totalAmtDeposited,
                bountyStartAmt: s.bountyParams.bountyStartAmt,
                roundLength: s.bountyParams.roundLength,
                bountyToken: s.bountyParams.bountyToken,
                bountyMultiplier: s.bountyParams.bountyMultiplier,
                maxRounds: s.bountyParams.maxRounds
            } : null
        };
    }

    /**
     * Get oracle params for a swap
     */
    async getOracleParams(swapId) {
        const contract = this.getContract();
        const o = await contract.getOracleParams(swapId);
        return {
            settlerReward: o.settlerReward,
            initialLiquidity: o.initialLiquidity,
            escalationHalt: o.escalationHalt,
            settlementTime: Number(o.settlementTime),
            latencyBailout: Number(o.latencyBailout),
            maxGameTime: Number(o.maxGameTime),
            blocksPerSecond: Number(o.blocksPerSecond),
            disputeDelay: Number(o.disputeDelay),
            swapFee: Number(o.swapFee),
            protocolFee: Number(o.protocolFee),
            multiplier: Number(o.multiplier),
            timeType: o.timeType
        };
    }

    /**
     * Get oracle report status
     * Struct order: currentAmount1, currentAmount2, price, currentReporter, reportTimestamp, settlementTimestamp, initialReporter, lastReportOppoTime, disputeOccurred, isDistributed
     */
    async getReportStatus(reportId) {
        if (!wallet.provider) throw new Error('Wallet not connected');
        const oracleContract = new ethers.Contract(CONFIG.contracts.openOracle, ORACLE_ABI, wallet.provider);
        const rs = await oracleContract.reportStatus(reportId);
        return {
            currentAmount1: rs.currentAmount1,
            currentAmount2: rs.currentAmount2,
            price: rs.price,
            currentReporter: rs.currentReporter,
            reportTimestamp: Number(rs.reportTimestamp),
            settlementTimestamp: Number(rs.settlementTimestamp),
            initialReporter: rs.initialReporter,
            lastReportOppoTime: Number(rs.lastReportOppoTime),
            disputeOccurred: rs.disputeOccurred,
            isDistributed: rs.isDistributed
        };
    }

    /**
     * Create a new swap
     */
    async createSwap({
        sellAmount,
        sellToken,
        minOut,
        buyToken,
        minFulfillLiquidity,
        expirationSeconds,
        gasCompensation,
        oracleParams,
        slippageParams,
        fulfillFeeParams,
        bountyParams
    }) {
        const contract = this.getContract(true);

        // Contract now takes seconds directly (calculates timestamp internally)
        const expiration = expirationSeconds;

        // Convert amounts to wei (use toFixed to avoid scientific notation)
        const gasCompWei = ethers.parseEther(typeof gasCompensation === 'number' ? gasCompensation.toFixed(18) : gasCompensation.toString());
        const settlerRewardWei = BigInt(oracleParams.settlerReward);
        const bountyTotalWei = BigInt(bountyParams.totalAmtDeposited);

        // Calculate msg.value
        // For ETH bounty (bountyToken == address(0)): extraEth = gasCompensation + bountyAmount + settlerReward + 1
        // For ERC20 bounty: extraEth = gasCompensation + settlerReward + 1
        const isEthBounty = bountyParams.bountyToken === '0x0000000000000000000000000000000000000000';
        let msgValue = gasCompWei + settlerRewardWei + BigInt(1);
        if (isEthBounty) {
            msgValue += bountyTotalWei;
        }

        // If selling ETH, add sellAmount to msg.value
        const isSellingEth = sellToken === '0x0000000000000000000000000000000000000000';
        if (isSellingEth) {
            msgValue += BigInt(sellAmount);
        }

        // Prepare oracle params struct
        const oracleParamsStruct = {
            settlerReward: oracleParams.settlerReward,
            initialLiquidity: oracleParams.initialLiquidity,
            escalationHalt: oracleParams.escalationHalt,
            settlementTime: oracleParams.settlementTime,
            latencyBailout: oracleParams.latencyBailout,
            maxGameTime: oracleParams.maxGameTime,
            blocksPerSecond: oracleParams.blocksPerSecond,
            disputeDelay: oracleParams.disputeDelay,
            swapFee: oracleParams.swapFee,
            protocolFee: oracleParams.protocolFee,
            multiplier: oracleParams.multiplier,
            timeType: oracleParams.timeType
        };

        // Prepare slippage params struct
        const slippageParamsStruct = {
            priceTolerated: slippageParams.priceTolerated,
            toleranceRange: slippageParams.toleranceRange
        };

        // Prepare fulfill fee params struct
        const fulfillFeeParamsStruct = {
            startFulfillFeeIncrease: 0, // Will be set by contract
            maxFee: fulfillFeeParams.maxFee,
            startingFee: fulfillFeeParams.startingFee,
            roundLength: fulfillFeeParams.roundLength,
            growthRate: fulfillFeeParams.growthRate,
            maxRounds: fulfillFeeParams.maxRounds
        };

        // Prepare bounty params struct (hardcoded values from old contract)
        const bountyParamsStruct = {
            totalAmtDeposited: bountyParams.totalAmtDeposited,
            bountyStartAmt: bountyParams.bountyStartAmt,
            roundLength: bountyParams.roundLength,
            bountyToken: bountyParams.bountyToken,
            bountyMultiplier: bountyParams.bountyMultiplier,
            maxRounds: bountyParams.maxRounds
        };

        // Check and approve tokens if not ETH
        if (!isSellingEth) {
            // When selling USDC with USDC bounty, need to approve sellAmount + bountyTotal
            const totalNeeded = bountyParams.bountyToken === sellToken
                ? BigInt(sellAmount) + bountyTotalWei
                : BigInt(sellAmount);
            const allowance = await wallet.getAllowance(sellToken, this.address);
            if (allowance < totalNeeded) {
                console.log('Approving token...');
                await wallet.approve(sellToken, this.address, totalNeeded);
            }
        } else if (!isEthBounty) {
            // Selling ETH but using ERC20 bounty (edge case, but handle it)
            const allowance = await wallet.getAllowance(bountyParams.bountyToken, this.address);
            if (allowance < bountyTotalWei) {
                console.log('Approving bounty token...');
                await wallet.approve(bountyParams.bountyToken, this.address, bountyTotalWei);
            }
        }

        // Get the swap ID before creating (nextSwapId will be our new swap's ID)
        const swapId = await this.getNextSwapId();

        // Execute swap (new param order: gasComp before oracleParams, bountyParams at end)
        const tx = await contract.swap(
            sellAmount,
            sellToken,
            minOut,
            buyToken,
            minFulfillLiquidity,
            expiration,
            gasCompWei,
            oracleParamsStruct,
            slippageParamsStruct,
            fulfillFeeParamsStruct,
            bountyParamsStruct,
            { value: msgValue }
        );

        const receipt = await tx.wait();

        // Save swap ID to localStorage
        this.saveSwapId(swapId, wallet.address);

        // Return swapId and txHash for status tracking
        return {
            receipt,
            swapId: Number(swapId),
            txHash: receipt.hash
        };
    }

    /**
     * Cancel a swap
     */
    async cancelSwap(swapId) {
        const contract = this.getContract(true);
        const tx = await contract.cancelSwap(swapId);
        return await tx.wait();
    }

    /**
     * Bail out of a swap
     */
    async bailOut(swapId) {
        const contract = this.getContract(true);
        const tx = await contract.bailOut(swapId);
        return await tx.wait();
    }

    /**
     * Settle a report (triggers swap execution)
     */
    async settleReport(reportId) {
        if (!wallet.signer) throw new Error('Wallet not connected');
        const oracleContract = new ethers.Contract(CONFIG.contracts.openOracle, ORACLE_ABI, wallet.signer);
        const tx = await oracleContract.settle(reportId);
        return await tx.wait();
    }

    /**
     * Get temp holdings for a user
     */
    async getTempHolding(userAddress, tokenAddress) {
        const contract = this.getContract();
        return await contract.tempHolding(userAddress, tokenAddress);
    }

    /**
     * Withdraw temp holdings
     */
    async withdrawTempHolding(tokenAddress, toAddress) {
        const contract = this.getContract(true);
        const tx = await contract.getTempHolding(tokenAddress, toAddress);
        return await tx.wait();
    }

    /**
     * Save swap ID to localStorage
     */
    saveSwapId(swapId, userAddress) {
        const key = `openswap_${userAddress.toLowerCase()}`;
        const stored = JSON.parse(localStorage.getItem(key) || '[]');
        if (!stored.includes(swapId.toString())) {
            stored.push(swapId.toString());
            localStorage.setItem(key, JSON.stringify(stored));
        }
    }

    /**
     * Get stored swap IDs from localStorage
     */
    getStoredSwapIds(userAddress) {
        const key = `openswap_${userAddress.toLowerCase()}`;
        return JSON.parse(localStorage.getItem(key) || '[]');
    }

    /**
     * Remove swap ID from localStorage
     */
    removeSwapId(swapId, userAddress) {
        const key = `openswap_${userAddress.toLowerCase()}`;
        const stored = JSON.parse(localStorage.getItem(key) || '[]');
        const filtered = stored.filter(id => id !== swapId.toString());
        localStorage.setItem(key, JSON.stringify(filtered));
    }

    /**
     * Get all swaps for a user (from localStorage)
     * Removes finished/cancelled swaps from storage
     * For matched orders, includes bailout status info
     */
    async getUserSwaps(userAddress) {
        const storedIds = this.getStoredSwapIds(userAddress);
        const userSwaps = [];

        for (const swapId of storedIds) {
            try {
                const swap = await this.getSwap(swapId);
                console.log(`[Contract] getSwap(${swapId}):`, { matched: swap.matched, finished: swap.finished, reportId: swap.reportId?.toString() });

                // Skip invalid/non-existent swaps (contract returns zero values for non-existent IDs)
                // Also skip swaps that don't belong to this user
                if (swap.sellAmt === BigInt(0) || swap.swapper.toLowerCase() !== userAddress.toLowerCase()) {
                    this.removeSwapId(swapId, userAddress);
                    continue;
                }

                // Remove finished or cancelled swaps from localStorage
                if (swap.finished || swap.cancelled) {
                    this.removeSwapId(swapId, userAddress);
                    continue;
                }

                const swapData = {
                    swapId: swapId.toString(),
                    ...swap
                };

                // For matched orders, fetch bailout-related data
                if (swap.matched && !swap.finished && swap.reportId > BigInt(0)) {
                    try {
                        const [oracleParams, reportStatus] = await Promise.all([
                            this.getOracleParams(swapId),
                            this.getReportStatus(swap.reportId)
                        ]);
                        swapData.oracleParams = oracleParams;
                        swapData.reportStatus = reportStatus;
                        swapData.bailoutInfo = this.calculateBailoutInfo(swap, oracleParams, reportStatus);
                    } catch (e) {
                        console.error(`Error fetching bailout info for swap ${swapId}:`, e);
                    }
                }

                userSwaps.push(swapData);
            } catch (e) {
                console.error(`Error fetching swap ${swapId}:`, e);
            }
        }

        return userSwaps;
    }

    /**
     * Calculate bailout availability and countdown info
     *
     * Bailout conditions from contract:
     * 1. isLatent: timeSinceMatch > latencyBailout AND reportTimestamp == 0 (no initial report)
     * 2. isGameTooLong: timeSinceMatch > maxGameTime (ALWAYS applies, regardless of report)
     * 3. isDistributed && !finished: Oracle settled but callback failed (edge case)
     */
    calculateBailoutInfo(swap, oracleParams, reportStatus) {
        const now = Math.floor(Date.now() / 1000);
        const start = Number(swap.start);
        const timeSinceMatch = now - start;

        const latencyBailout = oracleParams.latencyBailout;
        const maxGameTime = oracleParams.maxGameTime;
        const settlementTime = oracleParams.settlementTime;
        const hasInitialReport = reportStatus.reportTimestamp > 0;
        const isDistributed = reportStatus.isDistributed;

        // Bailout condition 1: No initial report after latencyBailout
        const latencyBailoutAvailable = (timeSinceMatch > latencyBailout) && !hasInitialReport;
        const latencyTimeRemaining = !hasInitialReport ? Math.max(0, latencyBailout - timeSinceMatch) : null;

        // Bailout condition 2: maxGameTime exceeded (ALWAYS a backup, regardless of report status)
        const maxGameTimeBailoutAvailable = timeSinceMatch > maxGameTime;
        const maxGameTimeRemaining = Math.max(0, maxGameTime - timeSinceMatch);

        // Bailout condition 3: Oracle distributed but swap callback failed
        const distributedBailoutAvailable = isDistributed;

        // Can bail out if ANY condition is met
        const canBailOut = latencyBailoutAvailable || maxGameTimeBailoutAvailable || distributedBailoutAvailable;

        // Settlement: when there's an initial report and oracle hasn't distributed yet
        let canSettle = false;
        let settleCountdown = null;
        if (hasInitialReport && !isDistributed) {
            const timeSinceReport = now - reportStatus.reportTimestamp;
            if (timeSinceReport >= settlementTime) {
                canSettle = true;
            } else {
                settleCountdown = Math.max(0, settlementTime - timeSinceReport);
            }
        }

        // Determine primary status message and countdown for display
        let reason = null;
        let countdown = null;

        if (distributedBailoutAvailable) {
            // Edge case: oracle callback failed
            reason = 'Callback failed';
        } else if (!hasInitialReport) {
            // No initial report yet
            if (latencyBailoutAvailable) {
                reason = 'No initial report';
            } else {
                reason = 'Awaiting report';
                countdown = latencyTimeRemaining;
            }
        } else if (hasInitialReport && !isDistributed) {
            // Has initial report, oracle game in progress
            if (canSettle) {
                reason = 'Ready to settle';
            } else {
                reason = 'Settlement in';
                countdown = settleCountdown;
            }
        }

        return {
            canBailOut,
            canSettle,
            settleCountdown,
            reason,
            countdown,
            hasInitialReport,
            isDistributed,
            latencyBailoutAvailable,
            maxGameTimeBailoutAvailable,
            latencyTimeRemaining,
            maxGameTimeRemaining,
            reportId: swap.reportId
        };
    }

}

// Singleton instance
export const openSwap = new OpenSwapContract();
