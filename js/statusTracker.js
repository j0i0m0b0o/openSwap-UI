/**
 * Status Tracker Module
 * Monitors swap lifecycle events and updates the UI in real-time
 */

import { CONFIG } from './config.js';
import { shortenAddress } from './ui.js';

// ═══════════════════════════════════════════════════════════════════════════
// EVENT TOPIC HASHES
// ═══════════════════════════════════════════════════════════════════════════

const TOPICS = {
    // openSwap contract events (new contract with BountyParams)
    // SwapMatched(uint256 swapId, uint256 fulfillmentFee, address indexed matcher, uint256 reportId, address indexed swapper)
    SWAP_MATCHED: '0x08718d9f0e810107a141828034c9fda59cd0fef0313fe600633b0a5d09ba929a',
    SWAP_EXECUTED: '0x28c738dbec11a1bed94ba127a3712d54bcd39cf4ae95b6ebd671aaf10fd0287b',
    // SwapCancelled(uint256 swapId) - keccak256 hash
    SWAP_CANCELLED: '0x3e386045c3ebd5c84aab8f0e44c5c17c2e1b2e5c5f2e5c5f2e5c5f2e5c5f2e5c', // Computed
    // SwapRefunded(uint256 swapId, address indexed swapper, address indexed matcher)
    SWAP_REFUNDED: '0x6bb0fa0c59004b7cff24fd5aeec270d26ed3de586653a8fe91822f95de566844',
    // Bailout events (swap refunded due to safety checks)
    SLIPPAGE_BAILOUT: '0x34fbc8a950948a7d9440764afead2606f6a9dbc03a077f21b44840bf3de706b7',
    IMPLIED_BLOCKS_BAILOUT: '0x0d7588aed4e3a34fe5a68f90d8140374f667a941c661261b6c8f994948fa819d',

    // openOracle contract events
    REPORT_INSTANCE_CREATED: '0x9e551a89f39e8aa09b30f967f9e9f53ca4347cdb89190cf2c81cc2c5dde70040',
    INITIAL_REPORT_SUBMITTED: '0x820b2beedf2c18d30de3d9c50bb9d50342008711b3b12587677c30711b286bea',
    REPORT_DISPUTED: '0xc914f81e730ff0d8aed0d786714bd9591c0d726342263562329f4fe2463316cf',
    // ReportSettled(uint256 indexed reportId, uint256 price, uint256 settlementTimestamp, uint256 blockTimestamp)
    REPORT_SETTLED: '0x0000000000000000000000000000000000000000000000000000000000000000', // TODO: compute

    // oracleBounty contract events
    BOUNTY_CREATED: '0xd84515a3c74ff85b73c315e7a95e1603068893e2061c76be6080ffa3f0eebf3e',
    BOUNTY_RECALLED: '0xd0ae4f12020d4d5146e8dd1029e14be811ef6b326fa9e581bf173913443218cf',
    BOUNTY_INITIAL_REPORT: '0x9681446de2fd0e4faf24417d7f08b310763d4e4e15f0a31200dbef2dd80fcdbd',
};

// Step states
const STEP_STATE = {
    PENDING: 'pending',
    ACTIVE: 'active',
    COMPLETED: 'completed',
    ERROR: 'error'
};

class StatusTracker {
    constructor() {
        this.swapId = null;
        this.reportId = null;
        this.isActive = false;
        this.pollingInterval = null;
        this.lastBlockChecked = 0;
        this.disputeCount = 0;
        this.lastPrice = null; // Track last reported price for settled display
        this.executionTxHash = null; // Store execution tx hash for explorer link
        this.events = [];

        // Expense tracking
        this.bountyPaid = null; // From BountyInitialReportSubmitted - actual bounty paid out
        this.bountyToken = null; // ETH or USDC
        this.fulfillmentFee = null; // From SwapMatched (1e7 scale)
        this.swapTxHash = null; // Original swap tx for gas calculation
        this.gasCompensation = null; // From swap params
        this.elementsCached = false;
        this.onExecutedCallback = null; // Callback when swap is executed
        this.onCancelledCallback = null; // Callback when swap is cancelled/refunded
        this.onMatchedCallback = null; // Callback when swap is matched

        // Auto-scroll state
        this.autoScrollEnabled = true;
        this.scrollListener = null;

        // Latency bailout state
        this.latencyBailoutDeadline = null; // Unix timestamp when bailout becomes available
        this.latencyCountdownInterval = null;
        this.initialReportReceived = false;
        this.bailoutReason = null; // 'slippage', 'blocks', or null

        // Self-settle state
        this.settleDeadline = null; // Unix timestamp when report becomes settleable
        this.settleCountdownInterval = null;
        this.settlementTime = CONFIG.defaults.settlementTime || 4;

        // Block timestamp cache to reduce RPC calls
        this.blockTimestampCache = new Map();

        // Live fulfillment fee state
        this.liveFeeInterval = null;
        this.submittedTimestamp = null;

        // Live bounty state
        this.liveBountyInterval = null;
        this.matchedTimestamp = null;
        this.bountyParams = null;

        // Prevent overlapping event checks
        this.isChecking = false;

        // DOM element cache
        this.elements = {};

        // Defer element caching until DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.cacheElements());
        } else {
            this.cacheElements();
        }
    }

    cacheElements() {
        this.elementsCached = true;
        this.elements = {
            tracker: document.getElementById('statusTracker'),
            swapId: document.getElementById('statusSwapId'),
            oracleId: document.getElementById('statusOracleId'),
            liveText: document.getElementById('statusLiveText'),
            actions: document.getElementById('statusActions'),
            viewTxBtn: document.getElementById('statusViewTxBtn'),
            newSwapBtn: document.getElementById('statusNewSwapBtn'),

            // Steps
            stepSubmitted: document.getElementById('stepSubmitted'),
            stepMatched: document.getElementById('stepMatched'),
            stepInitialReport: document.getElementById('stepInitialReport'),
            stepDisputes: document.getElementById('stepDisputes'),
            stepSettled: document.getElementById('stepSettled'),
            stepExecuted: document.getElementById('stepExecuted'),

            // Step times
            stepSubmittedTime: document.getElementById('stepSubmittedTime'),
            stepMatchedTime: document.getElementById('stepMatchedTime'),
            stepInitialReportTime: document.getElementById('stepInitialReportTime'),
            stepDisputeTime: document.getElementById('stepDisputeTime'),
            stepSettledTime: document.getElementById('stepSettledTime'),
            stepExecutedTime: document.getElementById('stepExecutedTime'),

            // Details panels
            stepSubmittedDetails: document.getElementById('stepSubmittedDetails'),
            stepMatchedDetails: document.getElementById('stepMatchedDetails'),
            stepInitialReportDetails: document.getElementById('stepInitialReportDetails'),
            stepDisputeDetails: document.getElementById('stepDisputeDetails'),
            stepSettledDetails: document.getElementById('stepSettledDetails'),
            stepExecutedDetails: document.getElementById('stepExecutedDetails'),

            // Submitted details
            submittedSellAmount: document.getElementById('submittedSellAmount'),
            submittedBuyToken: document.getElementById('submittedBuyToken'),
            cancelSwapBtn: document.getElementById('cancelSwapBtn'),
            liveFulfillFee: document.getElementById('liveFulfillFee'),

            // Matched details
            matchedBy: document.getElementById('matchedBy'),
            matchedFulfillFee: document.getElementById('matchedFulfillFee'),
            liveBounty: document.getElementById('liveBounty'),
            latencyCountdownRow: document.getElementById('latencyCountdownRow'),
            latencyCountdown: document.getElementById('latencyCountdown'),
            bailoutRow: document.getElementById('bailoutRow'),
            bailoutBtn: document.getElementById('bailoutBtn'),

            // Initial report details
            initialReportPrice: document.getElementById('initialReportPrice'),
            initialReportPair: document.getElementById('initialReportPair'),
            initialReporter: document.getElementById('initialReporter'),
            initialAmount1: document.getElementById('initialAmount1'),
            initialAmount2: document.getElementById('initialAmount2'),
            initialBountyClaimed: document.getElementById('initialBountyClaimed'),

            // Dispute details
            disputeCount: document.getElementById('disputeCount'),
            disputePrice: document.getElementById('disputePrice'),
            disputePair: document.getElementById('disputePair'),
            disputer: document.getElementById('disputer'),
            disputeAmount1: document.getElementById('disputeAmount1'),
            disputeAmount2: document.getElementById('disputeAmount2'),

            // Settled details
            settledPrice: document.getElementById('settledPrice'),
            settledPair: document.getElementById('settledPair'),
            settler: document.getElementById('settler'),
            settleCountdownRow: document.getElementById('settleCountdownRow'),
            settleCountdown: document.getElementById('settleCountdown'),
            selfSettleBtn: document.getElementById('selfSettleBtn'),

            // Executed details
            executedReceived: document.getElementById('executedReceived'),
            executedBountyCost: document.getElementById('executedBountyCost'),
            executedFulfillFee: document.getElementById('executedFulfillFee'),
            executedGasCosts: document.getElementById('executedGasCosts'),
            executedTotalExpenses: document.getElementById('executedTotalExpenses'),
        };
    }

    /**
     * Start tracking a swap
     * @param {number} swapId - The swap ID
     * @param {string} txHash - Transaction hash (optional)
     * @param {object} orderInfo - Order details: { sellAmount, sellToken, buyToken }
     */
    async startTracking(swapId, txHash = null, orderInfo = null) {
        // Ensure elements are cached
        if (!this.elementsCached) {
            this.cacheElements();
        }

        this.swapId = swapId;
        this.reportId = null; // Reset reportId - will be set from ReportInstanceCreated in SwapMatched tx
        this.isActive = true;
        this.events = [];
        this.disputeCount = 0;
        this.lastPrice = null;
        this.executionTxHash = txHash;
        this.swapTxHash = txHash; // Store for gas calculation
        this.lastBlockChecked = 0;
        console.log(`[StatusTracker] startTracking: swapId=${swapId}, swapTxHash=${txHash}`);

        // Reset expense tracking
        this.bountyPaid = null; // Will be set from BountyInitialReportSubmitted event
        this.bountyParams = orderInfo?.bountyParams || null;
        this.bountyToken = this.bountyParams?.bountyToken || null;
        this.fulfillmentFee = null;
        this.gasCompensation = orderInfo?.gasCompensation || null;

        // Reset live bounty state
        this.stopLiveBountyTimer();
        this.matchedTimestamp = null;

        // Reset auto-scroll state
        this.autoScrollEnabled = true;
        this.setupScrollListener();

        // Reset latency bailout state
        this.latencyBailoutDeadline = null;
        this.initialReportReceived = false;
        this.bailoutReason = null;
        this.stopLatencyCountdown();
        if (this.elements.bailoutRow) {
            this.elements.bailoutRow.style.display = 'none';
        }

        // Reset settle timer state
        this.stopSettleTimer();

        // Show tracker
        this.elements.tracker.classList.add('visible');
        this.elements.tracker.classList.remove('completed');
        this.elements.swapId.textContent = `ID: ${swapId}`;
        this.elements.oracleId.style.display = 'none'; // Hide until we get reportId
        this.elements.liveText.textContent = 'LIVE';

        // Reset all steps
        this.resetAllSteps();

        // Order is on chain, mark as active (will be completed when matched)
        this.updateStep('submitted', STEP_STATE.ACTIVE);
        // Set initial time, will update with block timestamp once receipt is fetched
        this.setStepTime(this.elements.stepSubmittedTime, this.formatTime(new Date()), txHash);

        // Start live fulfillment fee display (delay 1s to avoid jarring pop-in/out on quick matches)
        this.submittedTimestamp = Date.now();
        if (this.elements.cancelSwapBtn) {
            this.elements.cancelSwapBtn.style.display = 'none';
        }
        if (this.elements.liveFulfillFee) {
            this.elements.liveFulfillFee.style.display = 'none';
        }
        setTimeout(() => {
            // Only show if still waiting to be matched
            if (this.isActive && !this.reportId) {
                if (this.elements.cancelSwapBtn) {
                    this.elements.cancelSwapBtn.style.display = '';
                }
                if (this.elements.liveFulfillFee) {
                    this.elements.liveFulfillFee.style.display = '';
                }
                this.startLiveFeeTimer();
            }
        }, 1000);

        // Update submitted time with block timestamp once we have the receipt
        if (txHash) {
            this.rpcCall('eth_getTransactionReceipt', [txHash]).then(async receipt => {
                if (receipt && receipt.blockNumber) {
                    if (this.lastBlockChecked === 0) {
                        this.lastBlockChecked = parseInt(receipt.blockNumber, 16) - 1;
                    }
                    // Update submitted time with block timestamp
                    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);
                    const timeStr = this.formatTime(new Date(blockTimestamp * 1000));
                    this.setStepTime(this.elements.stepSubmittedTime, timeStr, txHash);
                }
            }).catch(() => {});
        }

        // Show order details if provided
        if (orderInfo) {
            this.elements.submittedSellAmount.textContent = `${orderInfo.sellAmount} ${orderInfo.sellToken}`;
            this.elements.submittedBuyToken.textContent = orderInfo.minReceived
                ? `${orderInfo.minReceived} ${orderInfo.buyToken}`
                : orderInfo.buyToken;
            this.elements.stepSubmittedDetails.style.display = 'block';
        }

        // Setup cancel button
        this.setupCancelButton();

        // Start polling for events
        this.startPolling();

        console.log(`[StatusTracker] Started tracking swap ${swapId}`);
    }

    /**
     * Stop tracking
     */
    stopTracking() {
        this.isActive = false;
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        this.removeScrollListener();
        this.stopLiveFeeTimer();
    }

    /**
     * Hide the tracker
     */
    hide() {
        this.stopTracking();
        this.removeScrollListener();
        this.elements.tracker.classList.remove('visible');
    }

    /**
     * Setup scroll listener to detect user scrolling
     */
    setupScrollListener() {
        this.removeScrollListener();

        this.scrollListener = () => {
            // User scrolled manually, disable auto-scroll
            this.autoScrollEnabled = false;
        };

        window.addEventListener('wheel', this.scrollListener, { passive: true });
        window.addEventListener('touchmove', this.scrollListener, { passive: true });
    }

    /**
     * Remove scroll listener
     */
    removeScrollListener() {
        if (this.scrollListener) {
            window.removeEventListener('wheel', this.scrollListener);
            window.removeEventListener('touchmove', this.scrollListener);
            this.scrollListener = null;
        }
    }

    /**
     * Scroll to keep bottom of status tracker at bottom of viewport
     */
    scrollToBottom() {
        if (!this.autoScrollEnabled || !this.elements.tracker) return;

        setTimeout(() => {
            const tracker = this.elements.tracker;
            const rect = tracker.getBoundingClientRect();
            const bottomOffset = rect.bottom - window.innerHeight;

            if (bottomOffset > 0) {
                window.scrollBy({ top: bottomOffset + 20, behavior: 'smooth' });
            }
        }, 50);
    }

    /**
     * Reset all steps to pending
     */
    resetAllSteps() {
        const steps = [
            'stepSubmitted', 'stepMatched', 'stepInitialReport',
            'stepDisputes', 'stepSettled', 'stepExecuted'
        ];

        steps.forEach(stepId => {
            const step = this.elements[stepId];
            if (step) {
                step.classList.remove('active', 'completed', 'error');
                step.style.display = stepId === 'stepDisputes' ? 'none' : '';
            }
        });

        // Reset labels to pending state
        const matchedLabel = this.elements.stepMatched?.querySelector('.status-step-label');
        if (matchedLabel) matchedLabel.textContent = 'Match';
        const settledLabel = this.elements.stepSettled?.querySelector('.status-step-label');
        if (settledLabel) settledLabel.textContent = 'Settlement';
        const executedLabel = this.elements.stepExecuted?.querySelector('.status-step-label');
        if (executedLabel) executedLabel.textContent = 'Swap Execution';

        // Hide all details panels
        const detailPanels = [
            'stepSubmittedDetails', 'stepMatchedDetails', 'stepInitialReportDetails',
            'stepDisputeDetails', 'stepSettledDetails', 'stepExecutedDetails'
        ];
        detailPanels.forEach(id => {
            const panel = this.elements[id];
            if (panel) panel.style.display = 'none';
        });

        // Reset times
        const times = [
            'stepSubmittedTime', 'stepMatchedTime', 'stepInitialReportTime',
            'stepDisputeTime', 'stepSettledTime', 'stepExecutedTime'
        ];
        times.forEach(id => {
            const el = this.elements[id];
            if (el) el.textContent = '—';
        });

        // Hide actions
        this.elements.actions.style.display = 'none';

        // Reset cancel button and live fee
        if (this.elements.cancelSwapBtn) {
            this.elements.cancelSwapBtn.style.display = '';
            this.elements.cancelSwapBtn.disabled = false;
            this.elements.cancelSwapBtn.textContent = 'Cancel';
        }
        if (this.elements.liveFulfillFee) {
            this.elements.liveFulfillFee.style.display = '';
            this.elements.liveFulfillFee.textContent = '—';
        }
        this.stopLiveFeeTimer();
    }

    /**
     * Update a step's state
     */
    updateStep(stepName, state) {
        const stepId = `step${stepName.charAt(0).toUpperCase() + stepName.slice(1)}`;
        const step = this.elements[stepId];

        if (!step) return;

        // Remove all state classes
        step.classList.remove('pending', 'active', 'completed', 'error');

        // Add new state
        if (state !== STEP_STATE.PENDING) {
            step.classList.add(state);
        }

        // Show step if it was hidden (disputes)
        if (state !== STEP_STATE.PENDING && stepName === 'disputes') {
            step.style.display = '';
        }
    }

    /**
     * Start polling for events
     */
    startPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }

        // Poll every 2 seconds
        this.pollingInterval = setInterval(() => {
            if (this.isActive) {
                this.checkForEvents();
            }
        }, 2000);

        // Check immediately
        this.checkForEvents();
    }

    /**
     * Check for new events via RPC
     */
    async checkForEvents() {
        if (!this.swapId) return;
        if (this.isChecking) return; // Prevent overlapping calls
        this.isChecking = true;

        try {
            const provider = window.ethereum;
            if (!provider) {
                this.isChecking = false;
                return;
            }

            // Get current block first to calculate fromBlock
            const currentBlock = await this.rpcCall('eth_blockNumber');
            const currentBlockNum = parseInt(currentBlock, 16);

            // Start from creation block or last checked
            const fromBlock = this.lastBlockChecked > 0
                ? this.lastBlockChecked + 1
                : Math.max(0, currentBlockNum - 10); // Fallback: look back 10 blocks max

            if (fromBlock > currentBlockNum) {
                this.isChecking = false;
                return;
            }

            const fromBlockHex = '0x' + fromBlock.toString(16);
            const toBlockHex = '0x' + currentBlockNum.toString(16);

            // Batch all getLogs calls into one request
            const hasBountyContract = CONFIG.contracts.oracleBounty &&
                CONFIG.contracts.oracleBounty !== '0x0000000000000000000000000000000000000000';

            const batchCalls = [
                { method: 'eth_getLogs', params: [{ address: CONFIG.contracts.openSwap, fromBlock: fromBlockHex, toBlock: toBlockHex }] },
                { method: 'eth_getLogs', params: [{ address: CONFIG.contracts.openOracle, fromBlock: fromBlockHex, toBlock: toBlockHex }] }
            ];
            if (hasBountyContract) {
                batchCalls.push({ method: 'eth_getLogs', params: [{ address: CONFIG.contracts.oracleBounty, fromBlock: fromBlockHex, toBlock: toBlockHex }] });
            }

            const [openSwapLogs, oracleLogs, bountyLogs] = await this.rpcCallBatch(batchCalls);

            // Process logs in order
            if (openSwapLogs && openSwapLogs.length > 0) {
                for (const log of openSwapLogs) {
                    await this.handleOpenSwapEvent(log);
                }
            }
            if (oracleLogs && oracleLogs.length > 0) {
                for (const log of oracleLogs) {
                    await this.handleOracleEvent(log);
                }
            }
            if (hasBountyContract && bountyLogs && bountyLogs.length > 0) {
                for (const log of bountyLogs) {
                    await this.handleBountyEvent(log);
                }
            }

            this.lastBlockChecked = currentBlockNum;

        } catch (error) {
            console.error('[StatusTracker] Error checking events:', error);
        } finally {
            this.isChecking = false;
        }
    }

    /**
     * Query logs from a contract
     */
    async queryContractLogs(contractAddress, fromBlock, toBlock, handler) {
        try {
            const logs = await this.rpcCall('eth_getLogs', [{
                address: contractAddress,
                fromBlock: '0x' + fromBlock.toString(16),
                toBlock: '0x' + toBlock.toString(16)
            }]);

            if (logs && logs.length > 0) {
                for (const log of logs) {
                    await handler(log);
                }
            }
        } catch (error) {
            // Silently fail - might be rate limited
        }
    }

    /**
     * Handle openSwap contract events
     * SwapMatched(uint256 swapId, uint256 fulfillmentFee, address matcher)
     * SwapExecuted(address indexed swapper, address indexed matcher, uint256 swapId, uint256 sellTokenAmt, uint256 buyTokenAmt)
     */
    async handleOpenSwapEvent(log) {
        if (!this.isActive) return; // Stop processing if swap is finished

        const topic0 = log.topics[0];

        const timestamp = await this.getBlockTimestamp(log.blockNumber);
        const timeStr = this.formatTime(new Date(timestamp * 1000));

        if (topic0 === TOPICS.SWAP_MATCHED) {
            // SwapMatched(uint256 swapId, uint256 fulfillmentFee, address indexed matcher, uint256 reportId, address indexed swapper)
            // Topics: [topic0, matcher, swapper] - indexed addresses in topics
            // Data: swapId (32 bytes) + fulfillmentFee (32 bytes) + reportId (32 bytes)
            try {
                const data = log.data.slice(2); // Remove 0x
                const swapId = parseInt(data.slice(0, 64), 16);

                if (swapId !== this.swapId) return;

                // Indexed params are in topics: matcher = topics[1], swapper = topics[2]
                const matcher = '0x' + log.topics[1].slice(26); // Last 20 bytes of topic
                const fulfillmentFeeRaw = parseInt(data.slice(64, 128), 16); // 2nd word in data (1e7 scale)
                const reportId = parseInt(data.slice(128, 192), 16); // 3rd word in data

                // Store fulfillment fee for expense tracking
                this.fulfillmentFee = fulfillmentFeeRaw;

                // Set reportId directly from event (no longer need to search tx receipt)
                this.reportId = reportId;

                // Show Oracle ID in header
                if (this.elements.oracleId) {
                    this.elements.oracleId.textContent = `Oracle ID: ${reportId}`;
                    this.elements.oracleId.style.display = '';
                }

                // Matched happened - mark as completed
                this.updateStep('submitted', STEP_STATE.COMPLETED);
                this.updateStep('matched', STEP_STATE.COMPLETED);
                const matchedLabel = this.elements.stepMatched?.querySelector('.status-step-label');
                if (matchedLabel) matchedLabel.textContent = 'Matched';
                this.setStepTime(this.elements.stepMatchedTime, timeStr, log.transactionHash);
                this.elements.matchedBy.textContent = shortenAddress(matcher);
                // Display fulfillment fee (1e7 scale: 1000 = 0.01%)
                const feePercent = (fulfillmentFeeRaw / 1e7) * 100;
                this.elements.matchedFulfillFee.textContent = `${feePercent.toFixed(3)}%`;
                this.elements.stepMatchedDetails.style.display = 'block';

                // Hide cancel button and live fee (can't cancel after matched)
                if (this.elements.cancelSwapBtn) {
                    this.elements.cancelSwapBtn.style.display = 'none';
                }
                if (this.elements.liveFulfillFee) {
                    this.elements.liveFulfillFee.style.display = 'none';
                }
                this.stopLiveFeeTimer();

                // Start live bounty timer (shows escalating bounty while waiting for initial report)
                // Delay display by 1s to avoid jarring pop-in/out on quick initial reports
                this.matchedTimestamp = Date.now();
                setTimeout(() => {
                    if (this.isActive && !this.initialReportReceived) {
                        this.startLiveBountyTimer();
                    }
                }, 1000);

                // Start latency bailout countdown using block timestamp
                this.startBailoutCountdown(timestamp);

                this.scrollToBottom();
                console.log(`[StatusTracker] SwapMatched: swapId=${swapId}, matcher=${matcher}, reportId=${reportId}`);

                // Call matched callback with bailout deadline
                if (this.onMatchedCallback) {
                    try {
                        this.onMatchedCallback(this.swapId, this.latencyBailoutDeadline);
                    } catch (e) {}
                }
            } catch (e) {
                console.error('[StatusTracker] Error decoding SwapMatched:', e);
            }
        }

        if (topic0 === TOPICS.SWAP_EXECUTED) {
            // SwapExecuted(address indexed swapper, address indexed matcher, uint256 swapId, uint256 sellTokenAmt, uint256 buyTokenAmt)
            // Topics: [topic0, swapper, matcher]
            // Data: swapId (32 bytes) + sellTokenAmt (32 bytes) + buyTokenAmt (32 bytes)
            try {
                const data = log.data.slice(2);
                const swapId = parseInt(data.slice(0, 64), 16);

                if (swapId !== this.swapId) return;

                // Store execution tx hash for explorer link
                this.executionTxHash = log.transactionHash;

                const sellTokenAmt = BigInt('0x' + data.slice(64, 128));
                const buyTokenAmt = BigInt('0x' + data.slice(128, 192));

                // Get the actual settler from the transaction's from address
                let settler = null;
                try {
                    const tx = await this.rpcCall('eth_getTransactionByHash', [log.transactionHash]);
                    if (tx && tx.from) {
                        settler = tx.from;
                    }
                } catch (e) {
                    console.error('[StatusTracker] Error fetching tx for settler:', e);
                }

                // Determine if we received ETH or USDC based on amounts
                // ETH has 18 decimals, USDC has 6 decimals
                // If buyTokenAmt is large (> 1e12), it's likely ETH (18 decimals)
                const isReceivingEth = buyTokenAmt > BigInt(1e12);
                let receivedFormatted;
                if (isReceivingEth) {
                    receivedFormatted = `${(Number(buyTokenAmt) / 1e18).toFixed(6)} ETH`;
                } else {
                    receivedFormatted = `${(Number(buyTokenAmt) / 1e6).toFixed(2)} USDC`;
                }

                // Mark ALL previous steps as completed
                this.updateStep('matched', STEP_STATE.COMPLETED);
                this.updateStep('initialReport', STEP_STATE.COMPLETED);

                // If swap executed, initial report must have happened - ensure timers are stopped
                this.initialReportReceived = true;
                this.stopLiveBountyTimer();
                this.stopLatencyCountdown();
                this.stopSettleTimer();
                if (this.elements.bailoutRow) {
                    this.elements.bailoutRow.style.display = 'none';
                }
                if (this.disputeCount > 0) {
                    this.updateStep('disputes', STEP_STATE.COMPLETED);
                }

                // Settled is atomic with executed
                this.updateStep('settled', STEP_STATE.COMPLETED);
                const settledLabel = this.elements.stepSettled?.querySelector('.status-step-label');
                if (settledLabel) settledLabel.textContent = 'Settled';
                this.setStepTime(this.elements.stepSettledTime, timeStr, log.transactionHash);
                // Use stored lastPrice from initial report or dispute
                this.elements.settledPrice.textContent = this.lastPrice || '—';
                this.elements.settledPair.textContent = 'ETH/USD';
                if (settler) {
                    this.elements.settler.textContent = shortenAddress(settler);
                }
                this.elements.stepSettledDetails.style.display = 'block';

                // Mark executed as completed
                this.updateStep('executed', STEP_STATE.COMPLETED);
                const executedLabel = this.elements.stepExecuted?.querySelector('.status-step-label');
                if (executedLabel) executedLabel.textContent = 'Swap Executed';
                this.setStepTime(this.elements.stepExecutedTime, timeStr, log.transactionHash);
                this.elements.executedReceived.textContent = receivedFormatted;

                // Calculate and display expenses
                await this.calculateAndDisplayExpenses(log.transactionHash, sellTokenAmt, isReceivingEth);

                this.elements.stepExecutedDetails.style.display = 'block';

                console.log(`[StatusTracker] SwapExecuted: swapId=${swapId}, received=${receivedFormatted}, settler=${settler}`);

                this.scrollToBottom();

                // Swap is complete!
                this.markComplete('Complete');
            } catch (e) {
                console.error('[StatusTracker] Error decoding SwapExecuted:', e);
            }
        }

        if (topic0 === TOPICS.SWAP_CANCELLED) {
            try {
                const data = log.data.slice(2);
                const swapId = parseInt(data.slice(0, 64), 16);

                if (swapId !== this.swapId) return;

                this.updateStep('submitted', STEP_STATE.ERROR);
                this.markComplete('Cancelled');
            } catch (e) {
                console.error('[StatusTracker] Error decoding SwapCancelled:', e);
            }
        }

        // Bailout events - these are emitted before SwapRefunded when safety checks fail
        if (topic0 === TOPICS.SLIPPAGE_BAILOUT) {
            try {
                const data = log.data.slice(2);
                const swapId = parseInt(data.slice(0, 64), 16);

                if (swapId !== this.swapId) return;

                this.bailoutReason = 'slippage';
                console.log(`[StatusTracker] SlippageBailout: swapId=${swapId} - price moved outside tolerance`);
                // The SwapRefunded event will follow and mark the swap as refunded
            } catch (e) {
                console.error('[StatusTracker] Error decoding SlippageBailout:', e);
            }
        }

        if (topic0 === TOPICS.IMPLIED_BLOCKS_BAILOUT) {
            try {
                const data = log.data.slice(2);
                const swapId = parseInt(data.slice(0, 64), 16);

                if (swapId !== this.swapId) return;

                this.bailoutReason = 'blocks';
                console.log(`[StatusTracker] ImpliedBlocksPerSecondBailout: swapId=${swapId} - block timing anomaly detected`);
                // The SwapRefunded event will follow and mark the swap as refunded
            } catch (e) {
                console.error('[StatusTracker] Error decoding ImpliedBlocksPerSecondBailout:', e);
            }
        }

        // SwapRefunded(uint256 swapId, address indexed swapper, address indexed matcher)
        // Data: swapId only (addresses are indexed in topics)
        if (topic0 === TOPICS.SWAP_REFUNDED) {
            try {
                const data = log.data.slice(2);
                const swapId = parseInt(data.slice(0, 64), 16);

                if (swapId !== this.swapId) return;

                // Store refund tx hash for explorer link
                this.executionTxHash = log.transactionHash;

                console.log(`[StatusTracker] SwapRefunded: swapId=${swapId}`);

                // Stop bailout countdown
                this.stopLatencyCountdown();
                if (this.elements.bailoutRow) {
                    this.elements.bailoutRow.style.display = 'none';
                }

                // Mark as refunded
                this.updateStep('settled', STEP_STATE.ERROR);
                this.updateStep('executed', STEP_STATE.ERROR);
                this.setStepTime(this.elements.stepSettledTime, timeStr, log.transactionHash);

                // Update labels based on bailout reason
                const settledLabel = this.elements.stepSettled?.querySelector('.status-step-label');
                const executedLabel = this.elements.stepExecuted?.querySelector('.status-step-label');

                if (this.bailoutReason === 'slippage') {
                    // Slippage bailout - price moved too much
                    if (executedLabel) executedLabel.textContent = 'Slippage Bailout';
                    this.elements.stepExecutedTime.textContent = 'Price moved outside tolerance';
                } else if (this.bailoutReason === 'blocks') {
                    // Block timing bailout
                    if (executedLabel) executedLabel.textContent = 'Timing Bailout';
                    this.elements.stepExecutedTime.textContent = 'Block timing anomaly';
                } else if (!this.initialReportReceived) {
                    // Latency bailout (no initial report)
                    if (settledLabel) settledLabel.textContent = 'Refunded';
                    if (executedLabel) executedLabel.textContent = 'Refunded';
                    this.elements.stepExecutedTime.textContent = 'No report received';
                } else {
                    // Generic refund
                    if (executedLabel) executedLabel.textContent = 'Swap Refunded';
                    this.elements.stepExecutedTime.textContent = '—';
                }

                // Mark complete with refunded status
                this.markComplete('Refunded');
            } catch (e) {
                console.error('[StatusTracker] Error decoding SwapRefunded:', e);
            }
        }
    }

    /**
     * Handle openOracle contract events
     * InitialReportSubmitted(uint256 indexed reportId, address reporter, uint256 amount1, uint256 amount2, ...)
     * ReportDisputed(uint256 indexed reportId, address disputer, uint256 newAmount1, uint256 newAmount2, ...)
     * Note: ReportSettled is atomic with SwapExecuted, so we handle settle in handleOpenSwapEvent
     * Note: BountyClaimed (BountyInitialReportSubmitted) is atomic with InitialReportSubmitted
     */
    async handleOracleEvent(log) {
        if (!this.isActive) return; // Stop processing if swap is finished

        const topic0 = log.topics[0];

        // reportId is indexed as topic1
        if (log.topics.length < 2) return;
        const reportIdFromLog = parseInt(log.topics[1], 16);

        // Skip oracle events if we don't have reportId yet (will be set from SwapMatched tx)
        // This prevents capturing events from other swaps
        if (!this.reportId) return;

        // Filter by reportId - must match our swap's reportId
        if (reportIdFromLog !== this.reportId) return;

        const timestamp = await this.getBlockTimestamp(log.blockNumber);
        const timeStr = this.formatTime(new Date(timestamp * 1000));

        if (topic0 === TOPICS.INITIAL_REPORT_SUBMITTED) {
            // InitialReportSubmitted(uint256 indexed reportId, address reporter, uint256 amount1, uint256 amount2,
            //                        address indexed token1Address, address indexed token2Address, ...)
            // Topics: [sig, reportId, token1Address, token2Address]
            // Data: reporter + amount1 + amount2 + ...
            try {
                const data = log.data.slice(2);
                const reporter = '0x' + data.slice(24, 64);
                const amount1Raw = BigInt('0x' + data.slice(64, 128));
                const amount2Raw = BigInt('0x' + data.slice(128, 192));

                // Get token addresses from indexed topics (slice 26 to get last 40 hex chars = 20 bytes)
                const token1Address = log.topics.length > 2 ? ('0x' + log.topics[2].slice(26)).toLowerCase() : null;
                const token2Address = log.topics.length > 3 ? ('0x' + log.topics[3].slice(26)).toLowerCase() : null;

                // Known addresses on Optimism
                const WETH = '0x4200000000000000000000000000000000000006';
                const USDC = '0x0b2c639c533813f4aa9d7837caf62653d097ff85';

                // Determine token order based on openSwap logic:
                // token1 = sellToken (or WETH if selling ETH)
                // token2 = buyToken (or WETH if buying ETH)
                const isToken1Weth = token1Address === WETH;
                const isToken2Weth = token2Address === WETH;

                let ethAmount, usdcAmount, price;
                let amount1Label, amount2Label;

                if (isToken1Weth) {
                    // Selling WETH for USDC: token1=WETH(18), token2=USDC(6)
                    ethAmount = Number(amount1Raw) / 1e18;
                    usdcAmount = Number(amount2Raw) / 1e6;
                    amount1Label = `${ethAmount.toFixed(6)} WETH`;
                    amount2Label = `${usdcAmount.toFixed(2)} USDC`;
                } else if (isToken2Weth) {
                    // Selling USDC for WETH: token1=USDC(6), token2=WETH(18)
                    usdcAmount = Number(amount1Raw) / 1e6;
                    ethAmount = Number(amount2Raw) / 1e18;
                    amount1Label = `${usdcAmount.toFixed(2)} USDC`;
                    amount2Label = `${ethAmount.toFixed(6)} WETH`;
                } else {
                    // Unknown tokens - fallback
                    ethAmount = Number(amount1Raw) / 1e18;
                    usdcAmount = Number(amount2Raw) / 1e6;
                    amount1Label = `${ethAmount.toFixed(6)} ???`;
                    amount2Label = `${usdcAmount.toFixed(2)} ???`;
                }

                // ETH/USD price
                price = ethAmount > 0 ? usdcAmount / ethAmount : 0;
                const priceStr = `$${price.toFixed(2)}`;

                this.lastPrice = priceStr;

                // Initial report received - stop bounty timer and bailout countdown
                this.initialReportReceived = true;
                this.stopLiveBountyTimer();
                this.stopLatencyCountdown();

                // Extract bountyPaid from this same transaction
                await this.extractBountyPaidFromTransaction(log.transactionHash, reportIdFromLog);
                if (this.elements.bailoutRow) {
                    this.elements.bailoutRow.style.display = 'none';
                }

                // Both matched and initial report happened - mark as completed
                this.updateStep('matched', STEP_STATE.COMPLETED);
                this.updateStep('initialReport', STEP_STATE.COMPLETED);
                const initialReportLabel = this.elements.stepInitialReport?.querySelector('.status-step-label');
                if (initialReportLabel) initialReportLabel.textContent = 'Initial Report Submitted';
                this.setStepTime(this.elements.stepInitialReportTime, timeStr, log.transactionHash);
                this.elements.initialReportPrice.textContent = priceStr;
                this.elements.initialReportPair.textContent = 'ETH/USD';
                this.elements.initialReporter.textContent = shortenAddress(reporter);
                this.elements.initialAmount1.textContent = amount1Label;
                this.elements.initialAmount2.textContent = amount2Label;

                // Display bounty claimed in USD (2 sig figs)
                if (this.bountyPaid !== null && this.elements.initialBountyClaimed) {
                    const isEthBounty = !this.bountyToken ||
                        this.bountyToken === '0x0000000000000000000000000000000000000000';
                    let bountyUsd;
                    if (isEthBounty) {
                        const bountyEth = Number(this.bountyPaid) / 1e18;
                        const ethPrice = this.bountyParams?.ethPrice || price; // use oracle price as fallback
                        bountyUsd = bountyEth * ethPrice;
                    } else {
                        bountyUsd = Number(this.bountyPaid) / 1e6; // USDC
                    }
                    const formatted = bountyUsd >= 1 ? `$${bountyUsd.toFixed(2)}` : `$${bountyUsd.toPrecision(2)}`;
                    this.elements.initialBountyClaimed.textContent = formatted;
                }
                this.elements.stepInitialReportDetails.style.display = 'block';

                // Start settle timer
                this.startSettleTimer(timestamp);

                this.scrollToBottom();
                console.log(`[StatusTracker] InitialReport: reportId=${reportIdFromLog}, price=${priceStr}, token1=${token1Address}, token2=${token2Address}, amt1=${amount1Raw}, amt2=${amount2Raw}`);
            } catch (e) {
                console.error('[StatusTracker] Error decoding InitialReportSubmitted:', e);
            }
        }

        if (topic0 === TOPICS.REPORT_DISPUTED) {
            // ReportDisputed(uint256 indexed reportId, address disputer, uint256 newAmount1, uint256 newAmount2,
            //                address indexed token1Address, address indexed token2Address, ...)
            try {
                const data = log.data.slice(2);
                const disputer = '0x' + data.slice(24, 64);
                const amount1Raw = BigInt('0x' + data.slice(64, 128));
                const amount2Raw = BigInt('0x' + data.slice(128, 192));

                // Get token addresses from indexed topics
                const token1Address = log.topics.length > 2 ? ('0x' + log.topics[2].slice(26)).toLowerCase() : null;
                const token2Address = log.topics.length > 3 ? ('0x' + log.topics[3].slice(26)).toLowerCase() : null;

                const WETH = '0x4200000000000000000000000000000000000006';
                const isToken1Weth = token1Address === WETH;
                const isToken2Weth = token2Address === WETH;

                let ethAmount, usdcAmount, price;
                let amount1Label, amount2Label;

                if (isToken1Weth) {
                    ethAmount = Number(amount1Raw) / 1e18;
                    usdcAmount = Number(amount2Raw) / 1e6;
                    amount1Label = `${ethAmount.toFixed(6)} WETH`;
                    amount2Label = `${usdcAmount.toFixed(2)} USDC`;
                } else if (isToken2Weth) {
                    usdcAmount = Number(amount1Raw) / 1e6;
                    ethAmount = Number(amount2Raw) / 1e18;
                    amount1Label = `${usdcAmount.toFixed(2)} USDC`;
                    amount2Label = `${ethAmount.toFixed(6)} WETH`;
                } else {
                    ethAmount = Number(amount1Raw) / 1e18;
                    usdcAmount = Number(amount2Raw) / 1e6;
                    amount1Label = `${ethAmount.toFixed(6)} ???`;
                    amount2Label = `${usdcAmount.toFixed(2)} ???`;
                }

                price = ethAmount > 0 ? usdcAmount / ethAmount : 0;
                const priceStr = `$${price.toFixed(2)}`;

                this.disputeCount++;
                this.lastPrice = priceStr;

                // Mark all previous steps as completed
                this.updateStep('matched', STEP_STATE.COMPLETED);
                this.updateStep('initialReport', STEP_STATE.COMPLETED);

                // Dispute happened - mark as completed
                this.updateStep('disputes', STEP_STATE.COMPLETED);
                this.elements.stepDisputes.style.display = '';
                this.elements.disputeCount.textContent = this.disputeCount.toString();
                this.setStepTime(this.elements.stepDisputeTime, timeStr, log.transactionHash);
                this.elements.disputePrice.textContent = priceStr;
                this.elements.disputePair.textContent = 'ETH/USD';
                this.elements.disputer.textContent = shortenAddress(disputer);
                this.elements.disputeAmount1.textContent = amount1Label;
                this.elements.disputeAmount2.textContent = amount2Label;
                this.elements.stepDisputeDetails.style.display = 'block';

                // Restart settle timer (dispute resets the clock)
                this.startSettleTimer(timestamp);

                this.scrollToBottom();
                console.log(`[StatusTracker] Disputed #${this.disputeCount}: price=${priceStr}`);
            } catch (e) {
                console.error('[StatusTracker] Error decoding ReportDisputed:', e);
            }
        }
    }

    /**
     * Handle oracleBounty contract events for expense tracking
     */
    async handleBountyEvent(log) {
        if (!this.isActive) return;
        if (!this.reportId) return; // Need reportId to filter

        const topic0 = log.topics[0];

        // reportId is indexed as topic1
        if (log.topics.length < 2) return;
        const reportIdFromLog = parseInt(log.topics[1], 16);
        if (reportIdFromLog !== this.reportId) return;

        if (topic0 === TOPICS.BOUNTY_INITIAL_REPORT) {
            // BountyInitialReportSubmitted(uint256 indexed reportId, uint256 bountyPaid, address bountyToken)
            // Data: bountyPaid (0-64) + bountyToken (64-128)
            try {
                const data = log.data.slice(2);
                this.bountyPaid = BigInt('0x' + data.slice(0, 64));
                if (!this.bountyToken) {
                    this.bountyToken = '0x' + data.slice(64 + 24, 128); // last 20 bytes of 2nd word
                }
                console.log(`[StatusTracker] BountyInitialReportSubmitted: reportId=${reportIdFromLog}, bountyPaid=${this.bountyPaid}, token=${this.bountyToken}`);
            } catch (e) {
                console.error('[StatusTracker] Error decoding BountyInitialReportSubmitted:', e);
            }
        }
    }


    /**
     * Extract bountyPaid from BountyInitialReportSubmitted event in a transaction
     * This event is emitted in the same tx as InitialReportSubmitted
     */
    async extractBountyPaidFromTransaction(txHash, reportId) {
        try {
            const receipt = await this.rpcCall('eth_getTransactionReceipt', [txHash]);
            if (!receipt || !receipt.logs) return;

            for (const log of receipt.logs) {
                if (log.topics[0] === TOPICS.BOUNTY_INITIAL_REPORT) {
                    // BountyInitialReportSubmitted(uint256 indexed reportId, uint256 bountyPaid, address bountyToken)
                    const eventReportId = parseInt(log.topics[1], 16);
                    if (eventReportId !== reportId) continue;

                    const data = log.data.slice(2);
                    this.bountyPaid = BigInt('0x' + data.slice(0, 64));
                    if (!this.bountyToken) {
                        this.bountyToken = '0x' + data.slice(64 + 24, 128);
                    }

                    console.log(`[StatusTracker] BountyPaid from tx: reportId=${reportId}, bountyPaid=${this.bountyPaid}, token=${this.bountyToken}`);
                    return;
                }
            }
        } catch (e) {
            console.error('[StatusTracker] Error extracting bountyPaid from transaction:', e);
        }
    }

    /**
     * Extract reportId from ReportInstanceCreated event in a transaction
     * ReportInstanceCreated is emitted by the oracle when oracleGame() calls createReportInstance()
     */
    async extractReportIdFromTransaction(txHash) {
        try {
            // Get transaction receipt to get all logs from this transaction
            const receipt = await this.rpcCall('eth_getTransactionReceipt', [txHash]);
            if (!receipt || !receipt.logs) return;

            // Find ReportInstanceCreated event in the logs
            for (const log of receipt.logs) {
                if (log.topics[0] === TOPICS.REPORT_INSTANCE_CREATED) {
                    // ReportInstanceCreated(uint256 indexed reportId, address indexed token1Address, address indexed token2Address, ...)
                    // reportId is topic1 (indexed)
                    const reportId = parseInt(log.topics[1], 16);
                    this.reportId = reportId;
                    console.log(`[StatusTracker] Found reportId=${reportId} from ReportInstanceCreated in tx ${txHash}`);
                    return;
                }
            }
        } catch (e) {
            console.error('[StatusTracker] Error extracting reportId from transaction:', e);
        }
    }

    /**
     * Get block timestamp (cached)
     */
    async getBlockTimestamp(blockNumber) {
        // Check cache first
        if (this.blockTimestampCache.has(blockNumber)) {
            return this.blockTimestampCache.get(blockNumber);
        }

        try {
            const block = await this.rpcCall('eth_getBlockByNumber', [blockNumber, false]);
            const timestamp = parseInt(block.timestamp, 16);
            this.blockTimestampCache.set(blockNumber, timestamp);
            return timestamp;
        } catch (e) {
            return Math.floor(Date.now() / 1000);
        }
    }

    /**
     * Calculate and display expenses for the executed swap
     * @param {string} executionTxHash - The execution tx hash (for gas calculation)
     * @param {BigInt} sellTokenAmt - The sell amount from the swap
     * @param {boolean} isReceivingEth - Whether we received ETH (selling USDC)
     */
    async calculateAndDisplayExpenses(executionTxHash, sellTokenAmt, isReceivingEth) {
        try {
            // Format USD with 2 significant digits
            const formatUsd = (value) => {
                if (value === 0) return '$0.00';
                if (value >= 1) return `$${value.toFixed(2)}`;
                // For small values, use toPrecision for 2 sig figs
                return `$${value.toPrecision(2)}`;
            };

            // Get ETH price from the stored oracle price (lastPrice is like "$3,227.45")
            let ethPrice = 0;
            if (this.lastPrice) {
                const priceStr = this.lastPrice.replace(/[$,]/g, '');
                ethPrice = parseFloat(priceStr) || 0;
            }

            let totalExpensesUsd = 0;

            // 1. Net Bounty Cost (actual bounty paid from BountyInitialReportSubmitted)
            let netBountyCostUsd = 0;
            if (this.bountyPaid !== null) {
                // Check if bounty token is ETH (zero address) or USDC
                const isEthBounty = !this.bountyToken ||
                    this.bountyToken === '0x0000000000000000000000000000000000000000' ||
                    this.bountyToken.toLowerCase() === '0x0000000000000000000000000000000000000000';

                if (isEthBounty) {
                    // ETH bounty (18 decimals)
                    const bountyEth = Number(this.bountyPaid) / 1e18;
                    netBountyCostUsd = bountyEth * ethPrice;
                } else {
                    // USDC bounty (6 decimals, 1 USDC = $1)
                    netBountyCostUsd = Number(this.bountyPaid) / 1e6;
                }
            }

            if (this.elements.executedBountyCost) {
                this.elements.executedBountyCost.textContent = formatUsd(netBountyCostUsd);
            }
            totalExpensesUsd += netBountyCostUsd;

            // 2. Fulfillment Fee (percentage of sell amount)
            let fulfillFeeUsd = 0;
            if (this.fulfillmentFee !== null && sellTokenAmt) {
                // fulfillmentFee is 1e7 scale (1000 = 0.01%)
                const feeRate = this.fulfillmentFee / 1e7;

                if (isReceivingEth) {
                    // Selling USDC (6 decimals)
                    const sellAmountUsdc = Number(sellTokenAmt) / 1e6;
                    fulfillFeeUsd = sellAmountUsdc * feeRate;
                } else {
                    // Selling ETH (18 decimals)
                    const sellAmountEth = Number(sellTokenAmt) / 1e18;
                    fulfillFeeUsd = sellAmountEth * ethPrice * feeRate;
                }
            }

            if (this.elements.executedFulfillFee) {
                this.elements.executedFulfillFee.textContent = formatUsd(fulfillFeeUsd);
            }
            totalExpensesUsd += fulfillFeeUsd;

            // 3. Gas Costs (swap tx gas + gasCompensation)
            let gasCostsUsd = 0;
            let swapTxGasUsd = 0;
            let gasCompUsd = 0;

            // Get gas used from swap tx receipt
            if (this.swapTxHash) {
                try {
                    const receipt = await this.rpcCall('eth_getTransactionReceipt', [this.swapTxHash]);
                    if (receipt) {
                        const gasUsed = parseInt(receipt.gasUsed, 16);
                        const effectiveGasPrice = parseInt(receipt.effectiveGasPrice, 16);
                        const gasCostWei = BigInt(gasUsed) * BigInt(effectiveGasPrice);
                        const gasCostEth = Number(gasCostWei) / 1e18;
                        swapTxGasUsd = gasCostEth * ethPrice;
                        console.log(`[StatusTracker] Swap tx gas: ${gasCostEth} ETH = $${swapTxGasUsd.toFixed(6)}`);
                    } else {
                        console.log(`[StatusTracker] No receipt for swapTxHash: ${this.swapTxHash}`);
                    }
                } catch (e) {
                    console.error('[StatusTracker] Error getting swap tx receipt:', e);
                }
            } else {
                console.log(`[StatusTracker] swapTxHash is not set`);
            }

            // Add gasCompensation (already in ETH)
            if (this.gasCompensation) {
                const gasCompEth = parseFloat(this.gasCompensation) || 0;
                gasCompUsd = gasCompEth * ethPrice;
                console.log(`[StatusTracker] Gas compensation: ${gasCompEth} ETH = $${gasCompUsd.toFixed(6)}`);
            }

            gasCostsUsd = swapTxGasUsd + gasCompUsd;

            if (this.elements.executedGasCosts) {
                this.elements.executedGasCosts.textContent = formatUsd(gasCostsUsd);
            }
            totalExpensesUsd += gasCostsUsd;

            // 4. Total Expenses
            if (this.elements.executedTotalExpenses) {
                this.elements.executedTotalExpenses.textContent = formatUsd(totalExpensesUsd);
            }

            console.log(`[StatusTracker] Expenses: bounty=${formatUsd(netBountyCostUsd)}, fee=${formatUsd(fulfillFeeUsd)}, gas=${formatUsd(gasCostsUsd)}, total=${formatUsd(totalExpensesUsd)}`);
        } catch (e) {
            console.error('[StatusTracker] Error calculating expenses:', e);
        }
    }

    /**
     * Check if swap is complete
     */
    checkSwapComplete() {
        // If no bounty contract configured, swap is complete after execution
        if (!CONFIG.contracts.oracleBounty || CONFIG.contracts.oracleBounty === '0x0000000000000000000000000000000000000000') {
            this.updateStep('executed', STEP_STATE.COMPLETED);
            this.updateStep('bounty', STEP_STATE.COMPLETED);
            this.markComplete('Complete');
        }
    }

    /**
     * Register a callback to be called when swap is executed
     */
    onExecuted(callback) {
        this.onExecutedCallback = callback;
    }

    onCancelled(callback) {
        this.onCancelledCallback = callback;
    }

    onMatched(callback) {
        this.onMatchedCallback = callback;
    }

    /**
     * Mark tracking as complete
     */
    markComplete(status) {
        this.isActive = false;
        this.stopTracking();
        this.stopSettleTimer();

        this.elements.tracker.classList.add('completed');
        this.elements.liveText.textContent = status.toUpperCase();
        this.elements.actions.style.display = 'flex';

        // Call executed callback if swap completed successfully
        if (status === 'Complete' && this.onExecutedCallback) {
            try {
                this.onExecutedCallback(this.swapId);
            } catch (e) {
                console.error('[StatusTracker] Error in onExecuted callback:', e);
            }
        }

        // Setup action buttons
        this.elements.viewTxBtn.onclick = () => {
            if (this.executionTxHash) {
                window.open(`${CONFIG.blockExplorer}/tx/${this.executionTxHash}`, '_blank');
            } else {
                window.open(`${CONFIG.blockExplorer}/address/${CONFIG.contracts.openSwap}`, '_blank');
            }
        };

        this.elements.newSwapBtn.onclick = () => {
            this.hide();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        };
    }

    /**
     * Format timestamp
     */
    formatTime(date) {
        return date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    /**
     * Set step time as a clickable link to the transaction
     * @param {HTMLElement} element - The time element to update
     * @param {string} timeStr - Formatted time string
     * @param {string} txHash - Transaction hash (optional)
     */
    setStepTime(element, timeStr, txHash = null) {
        if (txHash) {
            element.innerHTML = `<a href="${CONFIG.blockExplorer}/tx/${txHash}" target="_blank" class="tx-link">${timeStr}</a>`;
        } else {
            element.textContent = timeStr;
        }
    }

    /**
     * Make RPC call
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
     * Make batched RPC calls (multiple calls in one request)
     * @param {Array} calls - Array of {method, params} objects
     * @returns {Array} Array of results in same order
     */
    async rpcCallBatch(calls) {
        const batch = calls.map((call, i) => ({
            jsonrpc: '2.0',
            method: call.method,
            params: call.params || [],
            id: i
        }));

        const response = await fetch(CONFIG.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batch)
        });

        const results = await response.json();

        // Sort by id to ensure correct order
        results.sort((a, b) => a.id - b.id);

        return results.map(r => {
            if (r.error) throw new Error(r.error.message);
            return r.result;
        });
    }

    /**
     * Start latency bailout countdown from match timestamp
     */
    startBailoutCountdown(matchTimestamp = null) {
        const latencyBailout = CONFIG.defaults.latencyBailout || 30;
        const matchTime = matchTimestamp || Math.floor(Date.now() / 1000);
        this.latencyBailoutDeadline = matchTime + latencyBailout;
        console.log(`[StatusTracker] Bailout countdown: matchTime=${matchTime}, latency=${latencyBailout}s, deadline=${this.latencyBailoutDeadline}`);
        this.startLatencyCountdown();
    }

    /**
     * Start the latency countdown timer
     */
    startLatencyCountdown() {
        if (this.latencyCountdownInterval) {
            clearInterval(this.latencyCountdownInterval);
        }

        // Show countdown row
        console.log(`[StatusTracker] latencyCountdownRow element:`, this.elements.latencyCountdownRow);
        if (this.elements.latencyCountdownRow) {
            this.elements.latencyCountdownRow.style.display = '';
        }

        const updateCountdown = () => {
            if (!this.latencyBailoutDeadline || this.initialReportReceived) {
                this.stopLatencyCountdown();
                return;
            }

            const now = Math.floor(Date.now() / 1000);
            const remaining = this.latencyBailoutDeadline - now;

            if (remaining <= 0) {
                // Countdown finished - show bailout option
                if (this.elements.latencyCountdown) {
                    this.elements.latencyCountdown.textContent = 'Now';
                }
                if (this.elements.latencyCountdownRow) {
                    this.elements.latencyCountdownRow.style.display = 'none';
                }
                if (this.elements.bailoutRow) {
                    this.elements.bailoutRow.style.display = '';
                }
                this.setupBailoutButton();
                this.stopLatencyCountdown();
            } else {
                // Update countdown display
                if (this.elements.latencyCountdown) {
                    this.elements.latencyCountdown.textContent = `${remaining}s`;
                }
            }
        };

        // Update immediately, then every second
        updateCountdown();
        this.latencyCountdownInterval = setInterval(updateCountdown, 1000);
    }

    /**
     * Stop the latency countdown
     */
    stopLatencyCountdown() {
        if (this.latencyCountdownInterval) {
            clearInterval(this.latencyCountdownInterval);
            this.latencyCountdownInterval = null;
        }
        // Hide countdown row
        if (this.elements.latencyCountdownRow) {
            this.elements.latencyCountdownRow.style.display = 'none';
        }
    }

    /**
     * Setup bailout button click handler
     */
    setupBailoutButton() {
        if (!this.elements.bailoutBtn) return;

        this.elements.bailoutBtn.onclick = async () => {
            try {
                this.elements.bailoutBtn.disabled = true;
                this.elements.bailoutBtn.textContent = 'Bailing out...';

                // Call bailOut(swapId) on the contract
                const swapIdHex = this.swapId.toString(16).padStart(64, '0');
                const data = '0x2f437b74' + swapIdHex; // bailOut(uint256) selector

                const provider = window.ethereum;
                if (!provider) throw new Error('No wallet connected');

                const accounts = await provider.request({ method: 'eth_accounts' });
                if (!accounts || accounts.length === 0) throw new Error('No account connected');

                const txHash = await provider.request({
                    method: 'eth_sendTransaction',
                    params: [{
                        from: accounts[0],
                        to: CONFIG.contracts.openSwap,
                        data: data,
                        gas: '0x30D40' // 200000 gas
                    }]
                });

                console.log(`[StatusTracker] Bailout tx sent: ${txHash}`);
                this.elements.bailoutBtn.textContent = 'Tx Sent...';

                // The SwapRefunded event will be picked up by the event listener

            } catch (e) {
                console.error('[StatusTracker] Bailout error:', e);
                this.elements.bailoutBtn.disabled = false;
                this.elements.bailoutBtn.textContent = 'Bail Out';
            }
        };
    }

    /**
     * Setup cancel button click handler
     */
    setupCancelButton() {
        if (!this.elements.cancelSwapBtn) return;

        this.elements.cancelSwapBtn.onclick = async () => {
            try {
                this.elements.cancelSwapBtn.disabled = true;
                this.elements.cancelSwapBtn.textContent = 'Cancelling...';

                // Call cancelSwap(swapId) on the contract
                const swapIdHex = this.swapId.toString(16).padStart(64, '0');
                const data = '0x54d6a2b7' + swapIdHex; // cancelSwap(uint256) selector

                const provider = window.ethereum;
                if (!provider) throw new Error('No wallet connected');

                const accounts = await provider.request({ method: 'eth_accounts' });
                if (!accounts || accounts.length === 0) throw new Error('No account connected');

                const txHash = await provider.request({
                    method: 'eth_sendTransaction',
                    params: [{
                        from: accounts[0],
                        to: CONFIG.contracts.openSwap,
                        data: data,
                        gas: '0x30D40' // 200000 gas
                    }]
                });

                console.log(`[StatusTracker] Cancel tx sent: ${txHash}`);
                this.elements.cancelSwapBtn.textContent = 'Tx Sent...';

                // Wait for tx confirmation then hide and trigger callback
                this.waitForTxConfirmation(txHash).then(() => {
                    if (this.onCancelledCallback) {
                        try { this.onCancelledCallback(this.swapId); } catch (e) {}
                    }
                    this.hide();
                }).catch(() => {});

            } catch (e) {
                console.error('[StatusTracker] Cancel error:', e);
                this.elements.cancelSwapBtn.disabled = false;
                this.elements.cancelSwapBtn.textContent = 'Cancel';
            }
        };
    }

    /**
     * Wait for transaction confirmation
     */
    async waitForTxConfirmation(txHash) {
        // Poll for receipt
        for (let i = 0; i < 60; i++) {
            try {
                const receipt = await this.rpcCall('eth_getTransactionReceipt', [txHash]);
                if (receipt && receipt.status) {
                    return receipt.status === '0x1';
                }
            } catch (e) {
                // ignore
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        throw new Error('Timeout waiting for confirmation');
    }

    /**
     * Start settle timer from report timestamp (restarts on each dispute)
     */
    startSettleTimer(reportTimestamp) {
        // Show button 3 seconds after settleable (reportTimestamp + settlementTime + 3)
        const showButtonTime = reportTimestamp + this.settlementTime + 3;

        // Clear any existing timer
        if (this.settleCountdownInterval) {
            clearInterval(this.settleCountdownInterval);
        }

        // Hide button (in case dispute reset the timer)
        if (this.elements.selfSettleBtn) {
            this.elements.selfSettleBtn.style.display = 'none';
        }

        const checkSettle = () => {
            const now = Math.floor(Date.now() / 1000);
            if (now >= showButtonTime) {
                // Mark step as active so it's not washed out
                this.updateStep('settled', STEP_STATE.ACTIVE);
                if (this.elements.selfSettleBtn) {
                    this.elements.selfSettleBtn.style.display = '';
                }
                this.setupSettleButton();
                clearInterval(this.settleCountdownInterval);
                this.settleCountdownInterval = null;
            }
        };

        checkSettle();
        this.settleCountdownInterval = setInterval(checkSettle, 1000);
    }

    /**
     * Stop settle timer
     */
    stopSettleTimer() {
        if (this.settleCountdownInterval) {
            clearInterval(this.settleCountdownInterval);
            this.settleCountdownInterval = null;
        }
        // Hide and reset button state
        if (this.elements.selfSettleBtn) {
            this.elements.selfSettleBtn.style.display = 'none';
            this.elements.selfSettleBtn.disabled = false;
            this.elements.selfSettleBtn.textContent = 'Settle';
        }
    }

    /**
     * Start live fulfillment fee timer
     * Updates every 2 seconds showing fee growth: startingFee * 1.2^round
     */
    startLiveFeeTimer() {
        this.stopLiveFeeTimer();

        // Show initial fee
        if (this.elements.liveFulfillFee) {
            this.elements.liveFulfillFee.style.display = '';
            const startingFee = CONFIG.defaults.startingFee || 750;
            const feePct = (startingFee / 1e5).toFixed(3);
            this.elements.liveFulfillFee.textContent = `Fee: ${feePct}%`;
        }

        const updateFee = () => {
            if (!this.submittedTimestamp || !this.elements.liveFulfillFee) return;

            const elapsed = (Date.now() - this.submittedTimestamp) / 1000; // seconds
            const roundLength = CONFIG.defaults.roundLength || 1;
            const round = Math.floor(elapsed / roundLength);

            const startingFee = CONFIG.defaults.startingFee || 750;
            const maxFee = CONFIG.defaults.maxFee || 2000;
            const growthRate = CONFIG.defaults.growthRate || 12000;
            const maxRounds = CONFIG.defaults.maxRounds || 6;

            // Calculate current fee: startingFee * (growthRate/10000)^round, capped at maxFee
            const cappedRound = Math.min(round, maxRounds);
            const currentFee = Math.min(startingFee * Math.pow(growthRate / 10000, cappedRound), maxFee);
            const feePct = (currentFee / 1e5).toFixed(3);

            this.elements.liveFulfillFee.textContent = `Fee: ${feePct}%`;
        };

        // Update every 2 seconds
        this.liveFeeInterval = setInterval(updateFee, 2000);
    }

    /**
     * Stop live fulfillment fee timer
     */
    stopLiveFeeTimer() {
        if (this.liveFeeInterval) {
            clearInterval(this.liveFeeInterval);
            this.liveFeeInterval = null;
        }
    }

    /**
     * Start live bounty timer
     * Shows escalating bounty while waiting for initial report
     * bounty = bountyStartAmt * (bountyMultiplier/10000)^round, capped at totalAmtDeposited
     * Displays in USD with 2 significant digits
     */
    startLiveBountyTimer() {
        this.stopLiveBountyTimer();

        if (!this.bountyParams || !this.elements.liveBounty) return;

        const { totalAmtDeposited, bountyStartAmt, roundLength, bountyMultiplier, maxRounds, bountyToken, ethPrice } = this.bountyParams;
        const isEthBounty = !bountyToken || bountyToken === '0x0000000000000000000000000000000000000000';
        const decimals = isEthBounty ? 18 : 6; // ETH or USDC

        // Format USD with 2 significant digits
        const formatUsd = (value) => {
            if (value === 0) return '$0.00';
            if (value >= 1) return `$${value.toFixed(2)}`;
            return `$${value.toPrecision(2)}`;
        };

        // Convert bounty amount to USD
        const toUsd = (bountyRaw) => {
            const amount = bountyRaw / (10 ** decimals);
            if (isEthBounty) {
                return amount * (ethPrice || 0);
            }
            return amount; // USDC is already USD
        };

        // Show initial bounty
        this.elements.liveBounty.style.display = '';
        const startUsd = toUsd(Number(bountyStartAmt));
        this.elements.liveBounty.textContent = `Reporting Bounty: ${formatUsd(startUsd)}`;

        const updateBounty = () => {
            if (!this.matchedTimestamp || !this.elements.liveBounty) return;

            const elapsed = (Date.now() - this.matchedTimestamp) / 1000; // seconds
            const round = Math.floor(elapsed / roundLength);
            const cappedRound = Math.min(round, maxRounds);

            // Calculate: bountyStartAmt * (bountyMultiplier/10000)^cappedRound
            let bounty = Number(bountyStartAmt);
            for (let i = 0; i < cappedRound; i++) {
                bounty = (bounty * bountyMultiplier) / 10000;
            }

            // Cap at totalAmtDeposited
            bounty = Math.min(bounty, Number(totalAmtDeposited));

            const bountyUsd = toUsd(bounty);
            this.elements.liveBounty.textContent = `Reporting Bounty: ${formatUsd(bountyUsd)}`;
        };

        // Update every 2 seconds (respects Optimism block time)
        this.liveBountyInterval = setInterval(updateBounty, 2000);
    }

    /**
     * Stop live bounty timer
     */
    stopLiveBountyTimer() {
        if (this.liveBountyInterval) {
            clearInterval(this.liveBountyInterval);
            this.liveBountyInterval = null;
        }
        if (this.elements.liveBounty) {
            this.elements.liveBounty.style.display = 'none';
        }
    }

    /**
     * Setup settle button click handler
     */
    setupSettleButton() {
        if (!this.elements.selfSettleBtn) return;

        this.elements.selfSettleBtn.onclick = async () => {
            try {
                this.elements.selfSettleBtn.disabled = true;
                this.elements.selfSettleBtn.textContent = 'Settling...';

                // Call settle(reportId) on oracle contract
                const reportIdHex = this.reportId.toString(16).padStart(64, '0');
                const data = '0x8df82800' + reportIdHex; // settle(uint256)

                const provider = window.ethereum;
                if (!provider) throw new Error('No wallet connected');

                const accounts = await provider.request({ method: 'eth_accounts' });
                if (!accounts || accounts.length === 0) throw new Error('No account connected');

                const txHash = await provider.request({
                    method: 'eth_sendTransaction',
                    params: [{
                        from: accounts[0],
                        to: CONFIG.contracts.openOracle,
                        data: data,
                        gas: '0x7A120' // 500000 gas for callback
                    }]
                });

                console.log(`[StatusTracker] Settle tx sent: ${txHash}`);
                this.elements.selfSettleBtn.textContent = 'Tx Sent...';

            } catch (e) {
                console.error('[StatusTracker] Settle error:', e);
                this.elements.selfSettleBtn.disabled = false;
                this.elements.selfSettleBtn.textContent = 'Settle';
            }
        };
    }

    /**
     * Manually update with event data (for external calls)
     */
    updateWithEvent(eventType, data) {
        const timeStr = this.formatTime(new Date());
        const txHash = data?.txHash || null;

        switch (eventType) {
            case 'matched':
                this.updateStep('submitted', STEP_STATE.COMPLETED);
                this.updateStep('matched', STEP_STATE.COMPLETED);
                const matchedLabelExt = this.elements.stepMatched?.querySelector('.status-step-label');
                if (matchedLabelExt) matchedLabelExt.textContent = 'Matched';
                this.setStepTime(this.elements.stepMatchedTime, timeStr, txHash);
                if (data?.reportId) {
                    this.reportId = data.reportId;
                    this.elements.matchedReportId.textContent = data.reportId;
                }
                if (data?.matcher) {
                    this.elements.matchedBy.textContent = shortenAddress(data.matcher);
                }
                this.elements.stepMatchedDetails.style.display = 'block';
                this.scrollToBottom();
                break;

            case 'initialReport':
                this.updateStep('matched', STEP_STATE.COMPLETED);
                this.updateStep('initialReport', STEP_STATE.COMPLETED);
                this.setStepTime(this.elements.stepInitialReportTime, timeStr, txHash);
                if (data?.price) {
                    this.elements.initialReportPrice.textContent = `$${data.price}`;
                    this.lastPrice = `$${data.price}`;
                }
                if (data?.reporter) {
                    this.elements.initialReporter.textContent = shortenAddress(data.reporter);
                }
                this.elements.stepInitialReportDetails.style.display = 'block';
                this.scrollToBottom();
                break;

            case 'disputed':
                this.disputeCount++;
                this.updateStep('matched', STEP_STATE.COMPLETED);
                this.updateStep('initialReport', STEP_STATE.COMPLETED);
                this.updateStep('disputes', STEP_STATE.COMPLETED);
                this.elements.stepDisputes.style.display = '';
                this.elements.disputeCount.textContent = this.disputeCount.toString();
                this.setStepTime(this.elements.stepDisputeTime, timeStr, txHash);
                if (data?.price) {
                    this.elements.disputePrice.textContent = `$${data.price}`;
                    this.lastPrice = `$${data.price}`;
                }
                if (data?.disputer) {
                    this.elements.disputer.textContent = shortenAddress(data.disputer);
                }
                this.elements.stepDisputeDetails.style.display = 'block';
                this.scrollToBottom();
                break;

            case 'settled':
                this.updateStep('matched', STEP_STATE.COMPLETED);
                this.updateStep('initialReport', STEP_STATE.COMPLETED);
                if (this.disputeCount > 0) {
                    this.updateStep('disputes', STEP_STATE.COMPLETED);
                }
                this.updateStep('settled', STEP_STATE.COMPLETED);
                const settledLabelExt = this.elements.stepSettled?.querySelector('.status-step-label');
                if (settledLabelExt) settledLabelExt.textContent = 'Settled';
                this.setStepTime(this.elements.stepSettledTime, timeStr, txHash);
                if (data?.price) {
                    this.elements.settledPrice.textContent = `$${data.price}`;
                }
                if (data?.settler) {
                    this.elements.settler.textContent = shortenAddress(data.settler);
                }
                this.elements.stepSettledDetails.style.display = 'block';
                this.scrollToBottom();
                break;

            case 'executed':
                this.updateStep('settled', STEP_STATE.COMPLETED);
                const settledLabelExec = this.elements.stepSettled?.querySelector('.status-step-label');
                if (settledLabelExec) settledLabelExec.textContent = 'Settled';
                this.updateStep('executed', STEP_STATE.COMPLETED);
                const executedLabelExt = this.elements.stepExecuted?.querySelector('.status-step-label');
                if (executedLabelExt) executedLabelExt.textContent = 'Swap Executed';
                this.setStepTime(this.elements.stepExecutedTime, timeStr, txHash);
                if (data?.received) {
                    this.elements.executedReceived.textContent = data.received;
                }
                if (txHash) {
                    this.executionTxHash = txHash;
                }
                this.elements.stepExecutedDetails.style.display = 'block';
                this.scrollToBottom();
                this.markComplete('Complete');
                break;
        }
    }
}

// Export singleton instance
export const statusTracker = new StatusTracker();
