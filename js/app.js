/**
 * openSwap Application
 * Main application entry point - ETH/USDC only with Coinbase price feed
 */

import { CONFIG, NETWORKS, setNetwork } from './config.js';
import { wallet } from './wallet.js';
import { openSwap } from './contract.js';
import { ETH, USDC, getToken, formatTokenAmount, parseTokenAmount } from './tokens.js';
import { priceFeed } from './price.js';
import { priceValidator } from './priceValidator.js';
import { volatility } from './volatility.js';
import { gasOracle } from './gasOracle.js';
import { statusTracker } from './statusTracker.js';
import {
    showToast,
    openModal,
    closeModal,
    setButtonLoading,
    formatNumber,
    formatUSD,
    formatTimeRemaining,
    debounce,
    shortenAddress,
    validateNumericInput,
    createAvatar
} from './ui.js';

// Application State
const state = {
    sellToken: ETH,
    buyToken: USDC,
    sellAmount: '',
    buyAmount: '',
    currentView: 'swap',
    userOrders: [],
    currentPrice: null,
    priceSourcesValid: true, // False when price sources disagree
    isRecalculating: false, // True when recalculating slippage/bounty
    pendingRecalcId: 0, // Increments on user-triggered recalc, used to ignore stale callbacks
    activeRecalcId: 0, // The recalc ID that's currently being processed
    ordersRefreshInterval: null, // Interval for refreshing orders view (contract data)
    countdownInterval: null, // Interval for updating countdown displays every second
    matchedSwapIds: new Map(), // Track optimistically matched swaps: swapId -> bailoutDeadline
    needsSellAmountUpdate: false, // True when manual initLiq causes sellAmt + bounty > balance
    estTotalCostPct: null, // Estimated total cost as percentage of swap notional
    settings: {
        slippage: 0.2,
        deadline: 60
    }
};

// Delay Mode helpers (stored per address+network in localStorage)
function getDelayModeKey() {
    const address = wallet.address;
    const chainId = CONFIG.chainId;
    if (!address) return null;
    return `delayMode_${address.toLowerCase()}_${chainId}`;
}

function loadDelayMode() {
    const key = getDelayModeKey();
    if (!key) return false;
    return localStorage.getItem(key) === 'true';
}

function saveDelayMode(enabled) {
    const key = getDelayModeKey();
    if (!key) return;
    localStorage.setItem(key, enabled ? 'true' : 'false');
}

// DOM Elements
let elements = {};

/**
 * Initialize application
 */
async function init() {
    cacheElements();
    setupEventListeners();
    setupWalletListeners();
    setupPriceFeed();
    setupVolatilityTracker();
    initializeTokenDisplay();
    updateSwapButton();

    // Auto-connect if previously authorized
    tryAutoConnect();

    // Refresh balances every 5 seconds (use 'pending' to avoid stale cache)
    setInterval(() => {
        if (wallet.isConnected()) {
            updateBalances('pending');
        }
    }, 5000);

    // Refresh balances when swap is executed (with retry for RPC staleness)
    statusTracker.onExecuted(() => {
        console.log('[App] Swap executed, refreshing balances with pending blockTag...');
        updateBalances('pending');
        // RPC may be stale, retry with increasing delays
        setTimeout(() => updateBalances('pending'), 2000);
        setTimeout(() => updateBalances('pending'), 5000);
        setTimeout(() => updateBalances('latest'), 10000);
    });

    // Refresh balances when swap is cancelled
    statusTracker.onCancelled(() => {
        console.log('[App] Swap cancelled, refreshing balances...');
        updateBalances('pending');
        setTimeout(() => updateBalances('pending'), 1000);
    });

    // Refresh orders when swap is matched
    statusTracker.onMatched((swapId, bailoutDeadline) => {
        console.log('[App] Swap matched, updating orders...', { swapId, bailoutDeadline });
        // Track this as optimistically matched with bailout deadline
        if (swapId) state.matchedSwapIds.set(swapId.toString(), bailoutDeadline);
        // Re-render with optimistic update applied
        renderOrdersList();
    });

    // Handle page visibility change - refresh data when user returns
    setupVisibilityHandler();

    console.log('openSwap UI initialized - ETH/USDC');
}

/**
 * Setup visibility change handler to refresh stale data when user returns
 */
function setupVisibilityHandler() {
    let lastHidden = 0;

    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'hidden') {
            lastHidden = Date.now();
            return;
        }

        // Page became visible - check if we were hidden long enough to need refresh
        const hiddenDuration = Date.now() - lastHidden;
        if (hiddenDuration < 10000) return; // Less than 10s, data still fresh

        console.log(`[App] Page visible after ${Math.round(hiddenDuration / 1000)}s, refreshing data...`);

        // Disable swap button while refreshing
        const btn = elements.swapBtn;
        const wasDisabled = btn.disabled;
        const prevText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Refreshing...';

        try {
            // Refresh all data in parallel
            const refreshPromises = [
                volatility.calculate(true), // Force volatility refresh
            ];

            // Refresh gas if wallet connected
            if (wallet.isConnected() && wallet.provider) {
                refreshPromises.push(gasOracle.update(wallet.provider, true));
                refreshPromises.push(updateBalances('pending'));
            }

            await Promise.all(refreshPromises);

            console.log('[App] Data refreshed after visibility change');
        } catch (e) {
            console.error('[App] Error refreshing data:', e);
        }

        // Re-enable swap button (updateSwapButton will set correct state)
        updateSwapButton();
    });
}

/**
 * Try to auto-connect wallet if previously authorized
 */
async function tryAutoConnect() {
    if (!wallet.isAvailable()) return;

    try {
        // Check if already authorized (doesn't prompt)
        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
        if (accounts.length > 0) {
            await wallet.connect();
        }
    } catch (e) {
        // Silent fail - user can manually connect
    }
}

/**
 * Cache DOM elements
 */
function cacheElements() {
    elements = {
        // Header
        connectBtn: document.getElementById('connectBtn'),
        networkSwitcher: document.getElementById('networkSwitcher'),
        networkBtn: document.getElementById('networkBtn'),
        networkDropdown: document.getElementById('networkDropdown'),
        networkIcon: document.getElementById('networkIcon'),
        networkName: document.getElementById('networkName'),
        navTabs: document.querySelectorAll('.nav-tab'),
        mobileNavItems: document.querySelectorAll('.mobile-nav-item'),

        // Views
        swapView: document.getElementById('swapView'),
        ordersView: document.getElementById('ordersView'),

        // Swap inputs
        sellAmount: document.getElementById('sellAmount'),
        buyAmount: document.getElementById('buyAmount'),
        sellTokenSelector: document.getElementById('sellTokenSelector'),
        buyTokenSelector: document.getElementById('buyTokenSelector'),
        sellTokenSymbol: document.getElementById('sellTokenSymbol'),
        buyTokenSymbol: document.getElementById('buyTokenSymbol'),
        sellTokenIcon: document.getElementById('sellTokenIcon'),
        buyTokenIcon: document.getElementById('buyTokenIcon'),
        sellBalance: document.getElementById('sellBalance'),
        buyBalance: document.getElementById('buyBalance'),
        halfBtn: document.getElementById('halfBtn'),
        maxBtn: document.getElementById('maxBtn'),
        sellUsdValue: document.getElementById('sellUsdValue'),
        buyUsdValue: document.getElementById('buyUsdValue'),
        swapDirectionBtn: document.getElementById('swapDirectionBtn'),
        swapDetails: document.getElementById('swapDetails'),
        swapBtn: document.getElementById('swapBtn'),

        // Advanced settings
        advancedToggle: document.getElementById('advancedToggle'),
        advancedPanel: document.getElementById('advancedPanel'),
        expirationInput: document.getElementById('expirationInput'),
        settlerRewardInput: document.getElementById('settlerRewardInput'),
        settlementTimeInput: document.getElementById('settlementTimeInput'),
        initialLiquidityInput: document.getElementById('initialLiquidityInput'),
        maxBountyInput: document.getElementById('maxBountyInput'),
        maxBountyLabel: document.getElementById('maxBountyLabel'),
        delayModeToggle: document.getElementById('delayModeToggle'),
        slippageInput: document.getElementById('slippageInput'),

        // Gas debug
        gasDebugBaseFee: document.getElementById('gasDebugBaseFee'),
        gasDebugL1BaseFee: document.getElementById('gasDebugL1BaseFee'),
        gasDebugEffective: document.getElementById('gasDebugEffective'),
        gasDebugLowGas: document.getElementById('gasDebugLowGas'),
        gasDebugSwapL2: document.getElementById('gasDebugSwapL2'),
        gasDebugSwapL1: document.getElementById('gasDebugSwapL1'),
        gasDebugSwapTotal: document.getElementById('gasDebugSwapTotal'),
        gasDebugMatchL2: document.getElementById('gasDebugMatchL2'),
        gasDebugMatchL1: document.getElementById('gasDebugMatchL1'),
        gasDebugMatchTotal: document.getElementById('gasDebugMatchTotal'),
        gasDebugSettleL2: document.getElementById('gasDebugSettleL2'),
        gasDebugSettleL1: document.getElementById('gasDebugSettleL1'),
        gasDebugSettleTotal: document.getElementById('gasDebugSettleTotal'),

        // Cost breakdown
        costBreakdownToggle: document.getElementById('costBreakdownToggle'),
        costBreakdownPanel: document.getElementById('costBreakdownPanel'),
        estTotalCost: document.getElementById('estTotalCost'),
        costFulfillmentFee: document.getElementById('costFulfillmentFee'),
        costReporterReward: document.getElementById('costReporterReward'),
        costOtherGas: document.getElementById('costOtherGas'),

        // Modals
        tokenModal: document.getElementById('tokenModal'),
        tokenClose: document.getElementById('tokenClose'),
        tokenSearch: document.getElementById('tokenSearch'),
        tokenList: document.getElementById('tokenList'),

        // Orders view
        ordersList: document.getElementById('ordersList'),
        loadOrderInput: document.getElementById('loadOrderInput'),
        loadOrderBtn: document.getElementById('loadOrderBtn'),

        // Price display
        swapRate: document.getElementById('swapRate'),
        minReceived: document.getElementById('minReceived')
    };
}

/**
 * Initialize token display with ETH and USDC
 */
function initializeTokenDisplay() {
    updateTokenDisplay('sell', state.sellToken);
    updateTokenDisplay('buy', state.buyToken);
    elements.sellTokenSelector.classList.remove('empty');
    elements.buyTokenSelector.classList.remove('empty');
}

/**
 * Setup price feed
 */
function setupPriceFeed() {
    priceFeed.on(({ event, price, bid, ask }) => {
        if (event === 'price') {
            state.currentPrice = price;
            updatePriceDisplay();
            autoCalculateBuyAmount();
        } else if (event === 'connected') {
            showToast('Price Feed', 'Connected to Coinbase', 'success');
        } else if (event === 'disconnected') {
            showToast('Price Feed', 'Disconnected, reconnecting...', 'warning');
        }
    });

    // Connect to price feed
    priceFeed.connect();

    // Start price validator (validates Coinbase against other sources)
    priceValidator.on(({ event, reason, deviations }) => {
        const wasValid = state.priceSourcesValid;
        state.priceSourcesValid = (event === 'valid');

        if (wasValid !== state.priceSourcesValid) {
            updatePriceDisplay();
            updateSwapButtonState();
            if (!state.priceSourcesValid) {
                console.warn('[PriceValidator] Price sources disagree:', reason, deviations);
            }
        }
    });
    priceValidator.start();
}

/**
 * Setup volatility tracker for auto-slippage
 */
function setupVolatilityTracker() {
    volatility.on(({ iqr, candleVol, fallback }) => {
        // Update slippage input with recommended value (only if we have valid volatility data)
        if ((iqr !== null || candleVol !== null) && !fallback) {
            const recommended = volatility.getRecommendedSlippage();
            elements.slippageInput.value = recommended.toFixed(3);
            state.settings.slippage = recommended;
            console.log(`Auto-slippage updated: ${recommended.toFixed(3)}%`);
        }

        // Recalculate bounty (volatility affects bounty calculation)
        updateSwapDetails();

        // Update cost breakdown (IQR affects reporter reward estimate)
        updateCostBreakdown();

        // Only clear recalculating state if this callback is from the latest user-triggered recalc
        // (or if there's no pending user recalc, i.e., this is a periodic update)
        if (state.pendingRecalcId === 0 || state.activeRecalcId === state.pendingRecalcId) {
            state.isRecalculating = false;
            state.pendingRecalcId = 0;
            state.activeRecalcId = 0;
        }
        // Always update swap button to check balance against new bounty
        updateSwapButton();
    });

    // Initialize with current settlement time from input
    const initialSettlementTime = parseInt(elements.settlementTimeInput.value) || CONFIG.defaults.settlementTime;
    volatility.setSettlementTime(initialSettlementTime);

    // Start tracking
    volatility.start();
}

/**
 * Update price display in UI
 */
function updatePriceDisplay() {
    if (!state.currentPrice) return;

    const priceFormatted = formatNumber(state.currentPrice, 2);

    // Always show ETH price in USD
    if (elements.swapRate) {
        if (!state.priceSourcesValid) {
            elements.swapRate.textContent = 'Price sources disagree';
            elements.swapRate.style.color = 'var(--error)';
        } else {
            elements.swapRate.textContent = `1 ETH = $${priceFormatted}`;
            elements.swapRate.style.color = '';
        }
    }

    // Update USD values
    updateUsdValues();
}

/**
 * Update USD value displays
 */
function updateUsdValues() {
    if (!state.currentPrice) return;

    const sellAmt = parseFloat(state.sellAmount) || 0;
    const buyAmt = parseFloat(state.buyAmount) || 0;

    if (state.sellToken.symbol === 'ETH') {
        elements.sellUsdValue.textContent = formatUSD(sellAmt * state.currentPrice);
        elements.buyUsdValue.textContent = formatUSD(buyAmt);
    } else {
        elements.sellUsdValue.textContent = formatUSD(sellAmt);
        elements.buyUsdValue.textContent = formatUSD(buyAmt * state.currentPrice);
    }
}

/**
 * Update swap button state based on price validation
 */
function updateSwapButtonState() {
    const btn = elements.swapBtn;
    if (!btn) return;

    if (!state.priceSourcesValid) {
        btn.disabled = true;
        btn.classList.add('price-invalid');
    } else {
        btn.disabled = false;
        btn.classList.remove('price-invalid');
    }
}

/**
 * Auto-calculate buy amount based on current price
 */
function autoCalculateBuyAmount() {
    if (!state.currentPrice || !state.sellAmount) return;

    const sellAmt = parseFloat(state.sellAmount);
    if (isNaN(sellAmt) || sellAmt <= 0) return;

    let buyAmt;
    if (state.sellToken.symbol === 'ETH') {
        // Selling ETH for USDC
        buyAmt = sellAmt * state.currentPrice;
    } else {
        // Selling USDC for ETH
        buyAmt = sellAmt / state.currentPrice;
    }

    state.buyAmount = buyAmt.toFixed(state.buyToken.symbol === 'USDC' ? 2 : 12);
    elements.buyAmount.value = state.buyAmount;

    updateSwapDetails();
    updateUsdValues();
    updateSwapButton();
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Wallet connection
    elements.connectBtn.addEventListener('click', handleConnect);

    // Network switcher dropdown
    elements.networkBtn.addEventListener('click', () => {
        elements.networkSwitcher.classList.toggle('open');
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!elements.networkSwitcher.contains(e.target)) {
            elements.networkSwitcher.classList.remove('open');
        }
    });

    // Network option selection
    elements.networkDropdown.querySelectorAll('.network-option').forEach(option => {
        option.addEventListener('click', () => handleNetworkChange(option.dataset.network));
    });

    // Navigation
    elements.navTabs.forEach(tab => {
        tab.addEventListener('click', () => switchView(tab.dataset.view));
    });
    elements.mobileNavItems.forEach(item => {
        item.addEventListener('click', () => switchView(item.dataset.view));
    });

    // Swap direction
    elements.swapDirectionBtn.addEventListener('click', swapTokens);

    // Amount inputs
    elements.sellAmount.addEventListener('input', handleSellAmountChange);
    elements.buyAmount.addEventListener('input', handleBuyAmountChange);

    // Swap button
    elements.swapBtn.addEventListener('click', handleSwap);

    // Advanced toggle
    elements.advancedToggle.addEventListener('click', toggleAdvanced);

    // Cost breakdown toggle
    elements.costBreakdownToggle.addEventListener('click', toggleCostBreakdown);

    // Token modal close (we won't use the modal for selection anymore)
    elements.tokenClose.addEventListener('click', () => closeModal('tokenModal'));

    // Slippage manual input (capped at 0.5%)
    elements.slippageInput.addEventListener('change', () => {
        let val = parseFloat(elements.slippageInput.value);
        if (!isNaN(val) && val > 0) {
            val = Math.min(0.5, val); // cap at 0.5%
            elements.slippageInput.value = val;
            state.settings.slippage = val;
            updateSwapDetails();
        }
    });

    // Settlement time change - recalculate volatility/slippage
    // Use input event to catch changes immediately, debounce the actual recalc
    let settlementTimeDebounce = null;
    elements.settlementTimeInput.addEventListener('input', () => {
        const val = parseInt(elements.settlementTimeInput.value);
        if (!isNaN(val) && val > 0) {
            // Immediately disable button and increment pending recalc ID
            state.isRecalculating = true;
            state.pendingRecalcId++;
            const thisRecalcId = state.pendingRecalcId;
            updateSwapButton();

            // Debounce the actual recalculation (wait 500ms after last keystroke)
            clearTimeout(settlementTimeDebounce);
            settlementTimeDebounce = setTimeout(() => {
                // Mark this recalc as the active one
                state.activeRecalcId = thisRecalcId;
                volatility.setSettlementTime(val);
            }, 500);
        }
    });

    // Initial liquidity change - recalculate bounty, cost breakdown, and check balance
    elements.initialLiquidityInput.addEventListener('input', () => {
        recalculateBounty();
        updateCostBreakdown();
        updateSwapButton();
    });

    // Settler reward change - check balance (ETH sells only)
    elements.settlerRewardInput.addEventListener('input', () => {
        updateSwapButton();
    });

    // Max bounty change - check balance
    elements.maxBountyInput.addEventListener('input', () => {
        updateSwapButton();
    });

    // Delay mode toggle - save to localStorage
    elements.delayModeToggle.addEventListener('change', () => {
        saveDelayMode(elements.delayModeToggle.checked);
    });

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeModal(overlay.id);
            }
        });
    });

    // Validate numeric inputs
    [elements.sellAmount, elements.buyAmount].forEach(input => {
        input.addEventListener('input', () => validateNumericInput(input));
    });

    // Helper function to calculate max sellable amount (uses cached balance)
    function calculateMaxSellable() {
        if (!wallet.isConnected()) return null;

        const rawBalance = state.sellToken.rawBalance;
        if (!rawBalance || rawBalance === BigInt(0)) return null;

        // If selling ETH, reserve some for gasComp, bounty, settlerReward, and gas buffer
        if (state.sellToken.address === ethers.ZeroAddress && state.currentPrice > 0) {
            const balanceEth = parseFloat(ethers.formatEther(rawBalance));

            // Calculate overhead costs in ETH (gas oracle uses its own effective gas price)
            const gasCompEth = gasOracle.isReady()
                ? parseFloat(ethers.formatEther(gasOracle.getMatchCost()))
                : 0.001; // fallback
            const settlerRewardEth = gasOracle.isReady()
                ? parseFloat(ethers.formatEther(gasOracle.getSettleCost()))
                : 0.001; // fallback

            // Estimate bounty: ~0.1% of initialLiquidity (~10% of sellAmt) = ~0.01% of sellAmt
            const estimatedBountyEth = balanceEth * 0.0001; // 0.01%

            // Gas buffer: 25 cents worth of ETH
            const gasBufferEth = 0.25 / state.currentPrice;

            // Total overhead
            const overheadEth = gasCompEth + settlerRewardEth + estimatedBountyEth + gasBufferEth + 0.000001;

            // Max sellable amount
            const maxSellable = balanceEth - overheadEth;
            return maxSellable > 0 ? maxSellable : null;
        } else {
            // For USDC, reserve exact amount for bounty (bounty is paid in USDC when selling USDC)
            const balanceUsdc = parseFloat(rawBalance.toString()) / 1e6;

            // Calculate gas-floor minInitLiq (same as createSwap)
            const gasCostWei = gasOracle.getDisputeCostForInitLiq();
            const gasCostEth = parseFloat(ethers.formatEther(gasCostWei));
            const gasCostUsd = gasCostEth * state.currentPrice;
            const minInitLiqUsd = gasCostUsd * 12500; // gasCost / 0.008%

            // Get settlement-time volatility
            const settlementTime = parseInt(elements.settlementTimeInput.value) || CONFIG.defaults.settlementTime;
            let volSettlement;
            if (volatility.lastKrakenVol !== null) {
                volSettlement = volatility.lastKrakenVol / 6.5;
            } else if (volatility.lastCandleVol !== null) {
                volSettlement = (volatility.lastCandleVol / 1.5) / Math.sqrt(60 / settlementTime);
            } else {
                volSettlement = 0.001;
            }

            // Calculate bounty from minInitLiq (fixed cost regardless of sell amount)
            const minBountyFromGas = minInitLiqUsd * 0.0015; // 0.15% of gas-floor initLiq

            // Calculate bounty ratio for 10%-of-sell case
            const initLiqRatio = 0.1;
            const minBountyStartRatio = 0.000065 * initLiqRatio;
            const maxBountyStartRatio = 0.002 * initLiqRatio;
            const volBountyStartRatio = 0.5 * volSettlement * initLiqRatio;
            const bountyStartRatio = Math.min(Math.max(volBountyStartRatio, minBountyStartRatio), maxBountyStartRatio);
            const bountyRatioFromTenPct = Math.max(0.0015 * initLiqRatio, 2 * bountyStartRatio);

            // Solve for maxSellable considering both cases:
            const threshold = minInitLiqUsd / 0.1;
            const buffer = 0.0001; // 0.01% buffer

            let maxSellable;
            if (balanceUsdc - minBountyFromGas < threshold) {
                // Gas floor dominates: bounty is fixed
                maxSellable = balanceUsdc - minBountyFromGas - buffer * balanceUsdc;
            } else {
                // 10% of sell dominates: bounty is proportional
                maxSellable = balanceUsdc / (1 + bountyRatioFromTenPct + buffer);
            }

            return maxSellable > 0 ? maxSellable : null;
        }
    }

    // Helper to set sell amount and update UI
    function setSellAmount(amount) {
        const decimals = state.sellToken.address === ethers.ZeroAddress ? 6 : 6;
        elements.sellAmount.value = amount.toFixed(decimals);
        state.sellAmount = elements.sellAmount.value;
        autoCalculateBuyAmount();
        updateSwapButton();
        // Scroll so swap card bottom has buffer space below
        const swapCard = document.querySelector('.swap-card');
        if (swapCard) {
            const rect = swapCard.getBoundingClientRect();
            const buffer = 40; // pixels below the swap pane
            const targetScroll = window.scrollY + rect.bottom - window.innerHeight + buffer;
            window.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
        }
    }

    // MAX button
    elements.maxBtn.addEventListener('click', () => {
        try {
            const maxAmount = calculateMaxSellable();
            if (maxAmount === null) {
                if (state.sellToken.address === ethers.ZeroAddress) {
                    showToast('Insufficient Balance', 'Not enough ETH to cover swap overhead costs', 'error');
                } else {
                    showToast('Insufficient Balance', 'Not enough USDC to cover bounty', 'error');
                }
                return;
            }
            setSellAmount(maxAmount);
        } catch (e) {
            console.error('Error setting max balance:', e);
        }
    });

    // HALF button
    elements.halfBtn.addEventListener('click', () => {
        try {
            const maxAmount = calculateMaxSellable();
            if (maxAmount === null) {
                showToast('Insufficient Balance', 'Balance too low', 'error');
                return;
            }
            setSellAmount(maxAmount / 2);
        } catch (e) {
            console.error('Error setting half balance:', e);
        }
    });

    // Balance click also triggers MAX
    elements.sellBalance.parentElement.addEventListener('click', () => {
        try {
            const maxAmount = calculateMaxSellable();
            if (maxAmount === null) {
                if (state.sellToken.address === ethers.ZeroAddress) {
                    showToast('Insufficient Balance', 'Not enough ETH to cover swap overhead costs', 'error');
                } else {
                    showToast('Insufficient Balance', 'Not enough USDC to cover bounty', 'error');
                }
                return;
            }
            setSellAmount(maxAmount);
        } catch (e) {
            console.error('Error setting max balance:', e);
        }
    });

    // Load order by ID
    elements.loadOrderBtn.addEventListener('click', handleLoadOrder);
    elements.loadOrderInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleLoadOrder();
    });
}

/**
 * Setup wallet event listeners
 */
function setupWalletListeners() {
    wallet.on(async ({ event, address, chainId }) => {
        switch (event) {
            case 'connect':
                updateConnectButton(address);
                await updateBalances('pending');
                // Update gas oracle L1 fees
                gasOracle.update(wallet.provider);
                // Load delay mode setting for this address+network
                elements.delayModeToggle.checked = loadDelayMode();
                if (state.currentView === 'orders') {
                    loadUserOrders();
                }
                showToast('Connected', `Wallet connected: ${shortenAddress(address)}`, 'success');
                break;

            case 'disconnect':
                updateConnectButton(null);
                showToast('Disconnected', 'Wallet disconnected', 'info');
                break;

            case 'accountsChanged':
                updateConnectButton(address);
                await updateBalances('pending');
                // Load delay mode setting for new address
                elements.delayModeToggle.checked = loadDelayMode();
                showToast('Account Changed', `Now using: ${shortenAddress(address)}`, 'info');
                break;

            case 'chainChanged':
                if (chainId !== CONFIG.chainId) {
                    showToast('Wrong Network', `Please switch to ${CONFIG.chainName}`, 'warning');
                }
                break;
        }
        updateSwapButton();
    });
}

/**
 * Handle network change
 */
async function handleNetworkChange(networkKey) {
    setNetwork(networkKey);

    // Update UI
    const networkConfig = NETWORKS[networkKey];
    elements.networkName.textContent = networkConfig.chainName;
    elements.networkIcon.src = networkKey === 'optimism'
        ? 'https://assets.coingecko.com/coins/images/25244/small/Optimism.png'
        : 'https://avatars.githubusercontent.com/u/108554348?s=200&v=4';
    elements.networkIcon.alt = networkConfig.chainName;

    // Update active state in dropdown
    elements.networkDropdown.querySelectorAll('.network-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.network === networkKey);
    });

    // Close dropdown
    elements.networkSwitcher.classList.remove('open');

    // Update contract address
    openSwap.address = CONFIG.contracts.openSwap;

    // If wallet connected, prompt to switch chain
    if (wallet.isConnected()) {
        try {
            await wallet.switchNetwork(CONFIG.chainId);
            await updateBalances('pending');
        } catch (error) {
            showToast('Network Error', 'Failed to switch network', 'error');
        }
    }

    showToast('Network Changed', `Switched to ${CONFIG.chainName}`, 'success');
}

/**
 * Handle wallet connection
 */
async function handleConnect() {
    if (wallet.isConnected()) {
        wallet.disconnect();
        return;
    }

    try {
        setButtonLoading(elements.connectBtn, true);
        await wallet.connect();
    } catch (error) {
        console.error('Connection error:', error);
        showToast('Connection Failed', error.message, 'error');
    } finally {
        setButtonLoading(elements.connectBtn, false, wallet.isConnected() ? shortenAddress(wallet.address) : 'Connect Wallet');
    }
}

/**
 * Update connect button state
 */
function updateConnectButton(address) {
    if (address) {
        elements.connectBtn.innerHTML = `
            <div class="wallet-avatar">${createAvatar(address)}</div>
            ${shortenAddress(address)}
        `;
        elements.connectBtn.classList.add('connected');
    } else {
        elements.connectBtn.innerHTML = 'Connect Wallet';
        elements.connectBtn.classList.remove('connected');
    }
}

/**
 * Switch view
 */
function switchView(view) {
    state.currentView = view;

    // Update nav tabs
    elements.navTabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === view);
    });
    elements.mobileNavItems.forEach(item => {
        item.classList.toggle('active', item.dataset.view === view);
    });

    // Update view panels
    document.querySelectorAll('.view-panel').forEach(panel => {
        panel.classList.remove('active');
    });

    const viewElement = document.getElementById(`${view}View`);
    if (viewElement) {
        viewElement.classList.add('active');
    }

    // Load view-specific data and manage refresh intervals
    if (view === 'orders') {
        loadUserOrders();
        // Retry quickly in case RPC is stale
        setTimeout(() => loadUserOrders(), 2000);
        setTimeout(() => loadUserOrders(), 5000);
        // Start periodic refresh for contract data (every 10 seconds)
        if (state.ordersRefreshInterval) {
            clearInterval(state.ordersRefreshInterval);
        }
        state.ordersRefreshInterval = setInterval(() => {
            if (wallet.isConnected() && state.currentView === 'orders') {
                loadUserOrders();
            }
        }, 10000);
        // Start countdown update every second
        if (state.countdownInterval) {
            clearInterval(state.countdownInterval);
        }
        state.countdownInterval = setInterval(updateCountdowns, 1000);
    } else {
        // Clear intervals when leaving orders view
        if (state.ordersRefreshInterval) {
            clearInterval(state.ordersRefreshInterval);
            state.ordersRefreshInterval = null;
        }
        if (state.countdownInterval) {
            clearInterval(state.countdownInterval);
            state.countdownInterval = null;
        }
    }
}

/**
 * Update token display
 */
function updateTokenDisplay(side, token) {
    const symbolEl = side === 'sell' ? elements.sellTokenSymbol : elements.buyTokenSymbol;
    const iconEl = side === 'sell' ? elements.sellTokenIcon : elements.buyTokenIcon;

    symbolEl.textContent = token.symbol;

    if (token.logo) {
        iconEl.innerHTML = `<img src="${token.logo}" alt="${token.symbol}" onerror="this.style.display='none';this.parentElement.querySelector('span').style.display='block'"><span style="display:none">${token.symbol.slice(0, 2)}</span>`;
    } else {
        iconEl.innerHTML = `<span>${token.symbol.slice(0, 2)}</span>`;
    }
}

/**
 * Swap sell and buy tokens
 */
function swapTokens() {
    const tempToken = state.sellToken;
    state.sellToken = state.buyToken;
    state.buyToken = tempToken;

    // Swap amounts
    const tempAmount = state.sellAmount;
    state.sellAmount = state.buyAmount;
    state.buyAmount = tempAmount;

    // Reset cost estimate (needs recalculation for new direction)
    state.estTotalCostPct = null;

    // Use state balances if available (updated with pending blockTag), otherwise swap DOM values
    if (state.sellToken.balance && state.buyToken.balance) {
        elements.sellBalance.textContent = state.sellToken.balance;
        elements.buyBalance.textContent = state.buyToken.balance;
    } else {
        // Fallback: swap displayed balances immediately (before async fetch)
        const tempBalance = elements.sellBalance.textContent;
        elements.sellBalance.textContent = elements.buyBalance.textContent;
        elements.buyBalance.textContent = tempBalance;
    }

    updateTokenDisplay('sell', state.sellToken);
    updateTokenDisplay('buy', state.buyToken);

    elements.sellAmount.value = state.sellAmount;
    elements.buyAmount.value = state.buyAmount;

    updateBalances('pending');
    updatePriceDisplay();
    updateUsdValues();
    updateSwapButton();
}

/**
 * Handle sell amount change
 */
function handleSellAmountChange() {
    state.sellAmount = elements.sellAmount.value;
    state.estTotalCostPct = null; // Reset until recalculated
    if (!state.sellAmount || parseFloat(state.sellAmount) === 0) {
        state.buyAmount = '';
        elements.buyAmount.value = '';
        elements.swapDetails.classList.remove('visible');
    } else {
        autoCalculateBuyAmount();
    }
    updateSwapButton();
}

/**
 * Handle buy amount change (manual override)
 */
function handleBuyAmountChange() {
    state.buyAmount = elements.buyAmount.value;
    updateSwapDetails();
    updateUsdValues();
    updateSwapButton();
}

/**
 * Update swap details
 */
async function updateSwapDetails() {
    const hasAmounts = state.sellAmount && state.buyAmount && parseFloat(state.sellAmount) > 0 && parseFloat(state.buyAmount) > 0;

    if (hasAmounts && state.currentPrice) {
        elements.swapDetails.classList.add('visible');

        // Calculate min received based on slippage
        const slippage = state.settings.slippage / 100;
        const minReceived = parseFloat(state.buyAmount) * (1 - slippage);
        document.getElementById('minReceived').textContent = `${formatNumber(minReceived, state.buyToken.symbol === 'USDC' ? 2 : 6)} ${state.buyToken.symbol}`;
        const startingFeePct = (CONFIG.defaults.startingFee / 100000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
        const maxFeePct = (CONFIG.defaults.maxFee / 100000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
        document.getElementById('fulfillmentFee').textContent = `${startingFeePct}% / ${maxFeePct}%`;

        // Calculate and display initial liquidity, settler reward, and bounty
        try {
            const provider = wallet.provider;
            if (provider) {
                // Update gas oracle if needed (it caches internally)
                await gasOracle.update(provider);
                if (!gasOracle.isReady()) return;

                // Get gas costs from oracle (uses effective gas price with 15% tip)
                // For init liq floor, use the version with low gas regime floor (0.001 gwei clamp)
                const gasCostWei = gasOracle.getDisputeCostForInitLiq();

                // Calculate settler reward (includes 25% spread and low gas minimum)
                const settlerRewardWei = gasOracle.getSettleCost();
                const settlerRewardEth = Number(settlerRewardWei) / 1e18;
                elements.settlerRewardInput.placeholder = settlerRewardEth.toFixed(9);

                // Calculate initial liquidity: max(10% of sellAmt, gasCost / 0.008%)
                // 0.008% constraint means: gasCost <= 0.00008 * initLiq, so minInitLiq = gasCost / 0.00008 = gasCost * 12500
                const sellAmt = parseFloat(state.sellAmount);
                let initLiqValue, initLiqUsd;

                // Check if user has manually entered initLiq
                const manualInitLiq = elements.initialLiquidityInput.value;
                const hasManualInitLiq = manualInitLiq && manualInitLiq !== '' && manualInitLiq !== 'auto';

                if (state.sellToken.symbol === 'ETH') {
                    if (hasManualInitLiq) {
                        initLiqValue = parseFloat(manualInitLiq);
                        initLiqUsd = initLiqValue * state.currentPrice;
                    } else {
                        const minInitLiqWei = gasCostWei * BigInt(12500);  // gasCost / 0.008%
                        const tenPercentSellWei = BigInt(Math.floor(sellAmt * 1e18)) * BigInt(10) / BigInt(100);
                        const initLiqWei = tenPercentSellWei > minInitLiqWei ? tenPercentSellWei : minInitLiqWei;
                        initLiqValue = Number(initLiqWei) / 1e18;
                        initLiqUsd = initLiqValue * state.currentPrice;
                        elements.initialLiquidityInput.placeholder = initLiqValue.toFixed(6);
                    }
                    document.getElementById('initialLiquidityLabel').querySelector('span').textContent = 'Initial Liquidity (WETH)';
                } else {
                    if (hasManualInitLiq) {
                        initLiqUsd = parseFloat(manualInitLiq);
                    } else {
                        const gasCostEth = Number(gasCostWei) / 1e18;
                        const gasCostUsd = gasCostEth * state.currentPrice;
                        const minInitLiqUsd = gasCostUsd * 12500;  // gasCost / 0.008%
                        const tenPercentSellUsd = sellAmt * 0.10;
                        initLiqUsd = tenPercentSellUsd > minInitLiqUsd ? tenPercentSellUsd : minInitLiqUsd;
                        elements.initialLiquidityInput.placeholder = initLiqUsd.toFixed(2);
                    }
                    document.getElementById('initialLiquidityLabel').querySelector('span').textContent = 'Initial Liquidity (USDC)';
                }

                // Calculate bounty based on settlement-time volatility
                const settlementTime = parseInt(elements.settlementTimeInput.value) || CONFIG.defaults.settlementTime;
                let volSettlement;
                if (volatility.lastKrakenVol !== null) {
                    volSettlement = volatility.lastKrakenVol / 6.5; // already scaled to settlement time
                } else if (volatility.lastCandleVol !== null) {
                    volSettlement = (volatility.lastCandleVol / 1.5) / Math.sqrt(60 / settlementTime); // remove 1.5x, scale 1-min to settlement time
                } else {
                    volSettlement = 0.001; // fallback
                }

                // bountyStartAmt = 0.5 * vol * initLiq, min 0.0065%, capped at 0.2%
                const minBountyStartUsd = initLiqUsd * 0.000065; // 0.0065% floor
                const maxBountyStartUsd = initLiqUsd * 0.002; // 0.2% cap
                let bountyStartUsd = Math.max(0.5 * volSettlement * initLiqUsd, minBountyStartUsd);
                bountyStartUsd = Math.min(bountyStartUsd, maxBountyStartUsd);

                // totalAmtDeposited = max(0.15% of initLiq, 2 * bountyStartAmt)
                const minTotalUsd = initLiqUsd * 0.0015; // 0.15% floor
                const twiceBountyStart = bountyStartUsd * 2;
                const totalBountyUsd = Math.max(minTotalUsd, twiceBountyStart);

                // Display in USDC when selling USDC, ETH when selling ETH
                if (state.sellToken.address !== ethers.ZeroAddress) {
                    document.getElementById('oracleBounty').textContent = `${totalBountyUsd.toFixed(6)} USDC`;
                    elements.maxBountyInput.value = totalBountyUsd.toFixed(6);
                    elements.maxBountyLabel.querySelector('span').textContent = 'Max Bounty (USDC)';
                } else {
                    const totalBountyEth = totalBountyUsd / state.currentPrice;
                    document.getElementById('oracleBounty').textContent = `${totalBountyEth.toFixed(9)} ETH`;
                    elements.maxBountyInput.value = totalBountyEth.toFixed(9);
                    elements.maxBountyLabel.querySelector('span').textContent = 'Max Bounty (ETH)';
                }
            }
        } catch (e) {
            // Silently fail
        }

        // Update cost breakdown and gas debug
        updateCostBreakdown();
        updateGasDebug();
    } else {
        elements.swapDetails.classList.remove('visible');
    }
}

/**
 * Recalculate bounty based on initial liquidity input
 * bountyStartAmt = 0.5 * vol * initLiq, capped at 0.2%
 * totalAmtDeposited = 2 * bountyStartAmt
 */
function recalculateBounty() {
    const initLiqInput = elements.initialLiquidityInput.value;
    if (!initLiqInput || initLiqInput === '' || !state.currentPrice) return;

    try {
        let initLiqUsd;
        const initLiqValue = parseFloat(initLiqInput);
        if (isNaN(initLiqValue) || initLiqValue <= 0) return;

        if (state.sellToken.address === ethers.ZeroAddress) {
            // Selling ETH - initial liquidity is in ETH
            initLiqUsd = initLiqValue * state.currentPrice;
        } else {
            // Selling USDC - initial liquidity is in USDC
            initLiqUsd = initLiqValue;
        }

        // Get settlement-time σ as decimal
        const settlementTime = parseInt(elements.settlementTimeInput.value) || CONFIG.defaults.settlementTime;
        let volSettlement;
        if (volatility.lastKrakenVol !== null) {
            volSettlement = volatility.lastKrakenVol / 6.5; // already scaled to settlement time
        } else if (volatility.lastCandleVol !== null) {
            volSettlement = (volatility.lastCandleVol / 1.5) / Math.sqrt(60 / settlementTime); // remove 1.5x, scale 1-min to settlement time
        } else {
            volSettlement = 0.001; // fallback
        }

        // bountyStartAmt = 0.5 * vol * initLiq, min 0.0065%, capped at 0.2%
        const minBountyStartUsd = initLiqUsd * 0.000065; // 0.0065% floor
        const maxBountyStartUsd = initLiqUsd * 0.002; // 0.2% cap
        let bountyStartUsd = Math.max(0.5 * volSettlement * initLiqUsd, minBountyStartUsd);
        bountyStartUsd = Math.min(bountyStartUsd, maxBountyStartUsd);

        // totalAmtDeposited = max(0.15% of initLiq, 2 * bountyStartAmt)
        const minTotalUsd = initLiqUsd * 0.0015; // 0.15% floor
        const twiceBountyStart = bountyStartUsd * 2;
        const totalBountyUsd = Math.max(minTotalUsd, twiceBountyStart);

        // Display in USDC when selling USDC, ETH when selling ETH
        if (state.sellToken.address !== ethers.ZeroAddress) {
            document.getElementById('oracleBounty').textContent = `${totalBountyUsd.toFixed(6)} USDC`;
            elements.maxBountyInput.value = totalBountyUsd.toFixed(6);
            elements.maxBountyLabel.querySelector('span').textContent = 'Max Bounty (USDC)';
        } else {
            const totalBountyEth = totalBountyUsd / state.currentPrice;
            document.getElementById('oracleBounty').textContent = `${totalBountyEth.toFixed(9)} ETH`;
            elements.maxBountyInput.value = totalBountyEth.toFixed(9);
            elements.maxBountyLabel.querySelector('span').textContent = 'Max Bounty (ETH)';
        }
    } catch (e) {
        // Silently fail
    }
}

// Balance update sequence counter to prevent race conditions
let balanceUpdateSeq = 0;

/**
 * Update token balances
 * @param {string} blockTag - Optional block tag: "latest", "pending", or block number
 */
async function updateBalances(blockTag = 'latest') {
    if (!wallet.isConnected()) {
        elements.sellBalance.textContent = '0.00';
        elements.buyBalance.textContent = '0.00';
        return;
    }

    // Capture sequence and token addresses at start of this call
    const mySeq = ++balanceUpdateSeq;
    const sellAddr = state.sellToken.address;
    const buyAddr = state.buyToken.address;

    // Fetch both balances in parallel
    const [sellResult, buyResult] = await Promise.allSettled([
        wallet.getTokenBalance(sellAddr, blockTag),
        wallet.getTokenBalance(buyAddr, blockTag)
    ]);

    // If a newer call started while we were fetching, discard our results
    if (mySeq !== balanceUpdateSeq) {
        console.log(`[Balances] Discarding stale result (seq ${mySeq} < ${balanceUpdateSeq})`);
        return;
    }

    // If tokens were swapped while we were fetching, discard results
    if (sellAddr !== state.sellToken.address || buyAddr !== state.buyToken.address) {
        console.log(`[Balances] Discarding result - tokens changed mid-fetch`);
        return;
    }

    const sellBal = sellResult.status === 'fulfilled' ? sellResult.value.toString() : '0';
    const buyBal = buyResult.status === 'fulfilled' ? buyResult.value.toString() : '0';

    // Store raw and formatted balances in state for other functions to use
    state.sellToken.rawBalance = BigInt(sellBal);
    state.buyToken.rawBalance = BigInt(buyBal);
    state.sellToken.balance = formatTokenAmount(sellBal, state.sellToken.decimals);
    state.buyToken.balance = formatTokenAmount(buyBal, state.buyToken.decimals);

    console.log(`[Balances] ${state.sellToken.symbol}: ${sellBal} (${state.sellToken.balance}), ${state.buyToken.symbol}: ${buyBal} (${state.buyToken.balance})`);

    elements.sellBalance.textContent = state.sellToken.balance;
    elements.buyBalance.textContent = state.buyToken.balance;
}

/**
 * Update swap button state
 */
function updateSwapButton() {
    const btn = elements.swapBtn;

    // Don't update if button is in loading state
    if (btn.classList.contains('loading')) {
        return;
    }

    if (!wallet.isConnected()) {
        btn.textContent = 'Connect Wallet';
        btn.disabled = false;
        return;
    }

    if (!wallet.isCorrectNetwork()) {
        btn.textContent = `Switch to ${CONFIG.chainName}`;
        btn.disabled = false;
        return;
    }

    if (state.isRecalculating) {
        btn.textContent = 'Recalculating...';
        btn.disabled = true;
        return;
    }

    if (!state.sellAmount || parseFloat(state.sellAmount) === 0) {
        btn.textContent = 'Enter amount';
        btn.disabled = true;
        return;
    }

    // Require all data to be loaded - no fallbacks
    if (!state.currentPrice) {
        btn.textContent = 'Loading price...';
        btn.disabled = true;
        return;
    }

    if (volatility.lastCandleVol === null && volatility.lastIQR === null) {
        btn.textContent = 'Loading volatility...';
        btn.disabled = true;
        return;
    }

    if (!gasOracle.isReady()) {
        btn.textContent = 'Loading gas data...';
        btn.disabled = true;
        return;
    }

    if (!state.buyAmount || parseFloat(state.buyAmount) === 0) {
        btn.textContent = 'Waiting for price...';
        btn.disabled = true;
        return;
    }

    // Live check: if sellAmt + overhead > balance, show Update button
    if (state.sellToken?.balance && state.sellAmount) {
        const sellAmt = parseFloat(state.sellAmount);
        const balance = parseFloat(state.sellToken.balance);
        if (!isNaN(sellAmt) && !isNaN(balance) && sellAmt > 0) {
            // Get bounty: use manual maxBounty input if set, otherwise estimate from initLiq
            let bountyEst = 0;
            const maxBountyInput = elements.maxBountyInput.value;
            if (maxBountyInput && maxBountyInput !== '') {
                bountyEst = parseFloat(maxBountyInput);
            } else {
                const initLiqInput = elements.initialLiquidityInput.value || elements.initialLiquidityInput.placeholder;
                if (initLiqInput && initLiqInput !== '' && initLiqInput !== 'auto') {
                    const initLiq = parseFloat(initLiqInput);
                    bountyEst = initLiq * 0.0015; // 0.15% floor
                }
            }

            let totalNeeded;
            if (state.sellToken.address === ethers.ZeroAddress) {
                // ETH: also need gasComp + settlerReward
                const gasCompEth = gasOracle.isReady() ? parseFloat(ethers.formatEther(gasOracle.getMatchCost())) : 0.001;
                // Use manual settler reward if set, otherwise use oracle
                const settlerInput = elements.settlerRewardInput.value;
                const settlerEth = (settlerInput && settlerInput !== '')
                    ? parseFloat(settlerInput)
                    : (gasOracle.isReady() ? parseFloat(ethers.formatEther(gasOracle.getSettleCost())) : 0.001);
                totalNeeded = sellAmt + bountyEst + gasCompEth + settlerEth;
            } else {
                totalNeeded = sellAmt + bountyEst;
            }

            if (totalNeeded > balance) {
                btn.textContent = 'Update Sell Amount';
                btn.disabled = false;
                state.needsSellAmountUpdate = true;
                return;
            }
        }
    }
    state.needsSellAmountUpdate = false;

    // Check if swap notional exceeds $45 max (testing limit)
    const sellAmt = parseFloat(state.sellAmount);
    const notionalUsd = state.sellToken.symbol === 'ETH' ? sellAmt * state.currentPrice : sellAmt;
    if (notionalUsd > 45) {
        btn.textContent = 'Max swap size $45';
        btn.disabled = true;
        return;
    }

    // Check if fees are too high (Est Total Cost > 0.2%)
    if (state.estTotalCostPct !== null && state.estTotalCostPct > 0.2) {
        btn.textContent = 'Fees too high';
        btn.disabled = true;
        return;
    }

    btn.textContent = 'Create Swap';
    btn.disabled = false;
}

/**
 * Check if user has accepted risks for this wallet
 */
function hasAcceptedRisk() {
    if (!wallet.address) return false;
    const accepted = localStorage.getItem(`openswap_risk_accepted_${wallet.address.toLowerCase()}`);
    return accepted === 'true';
}

/**
 * Show risk acceptance modal and return promise that resolves when accepted
 */
function showRiskModal() {
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('riskModal');
        const acceptBtn = document.getElementById('riskAccept');
        const declineBtn = document.getElementById('riskDecline');

        if (!modal || !acceptBtn || !declineBtn) {
            console.error('[App] Risk modal elements not found');
            resolve(true); // Allow swap to proceed if modal missing
            return;
        }

        modal.classList.add('active');

        const handleAccept = () => {
            localStorage.setItem(`openswap_risk_accepted_${wallet.address.toLowerCase()}`, 'true');
            modal.classList.remove('active');
            acceptBtn.removeEventListener('click', handleAccept);
            declineBtn.removeEventListener('click', handleDecline);
            resolve(true);
        };

        const handleDecline = () => {
            modal.classList.remove('active');
            acceptBtn.removeEventListener('click', handleAccept);
            declineBtn.removeEventListener('click', handleDecline);
            reject(new Error('Risk not accepted'));
        };

        acceptBtn.addEventListener('click', handleAccept);
        declineBtn.addEventListener('click', handleDecline);
    });
}

async function handleSwap() {
    if (!wallet.isConnected()) {
        handleConnect();
        return;
    }

    if (!wallet.isCorrectNetwork()) {
        try {
            await wallet.switchNetwork(CONFIG.chainId);
        } catch (error) {
            showToast('Network Error', 'Failed to switch network', 'error');
        }
        return;
    }

    // Handle "Update Sell Amount" - recalculate sellAmount to fit balance
    if (state.needsSellAmountUpdate) {
        const balance = parseFloat(state.sellToken?.balance);

        if (isNaN(balance) || balance <= 0) {
            showToast('Insufficient Balance', `No ${state.sellToken.symbol} balance available`, 'error');
            return;
        }

        // Get bounty: use maxBountyInput if set, otherwise estimate from initLiq
        let bountyEst = 0;
        const maxBountyInput = elements.maxBountyInput.value;
        if (maxBountyInput && maxBountyInput !== '') {
            bountyEst = parseFloat(maxBountyInput);
        } else {
            const initLiqInput = elements.initialLiquidityInput.value || elements.initialLiquidityInput.placeholder;
            if (initLiqInput && initLiqInput !== '' && initLiqInput !== 'auto') {
                bountyEst = parseFloat(initLiqInput) * 0.0015;
            }
        }

        let newSellAmt;
        let symbol;

        if (state.sellToken.address === ethers.ZeroAddress) {
            const gasCompEth = gasOracle.isReady() ? parseFloat(ethers.formatEther(gasOracle.getMatchCost())) : 0.001;
            const settlerInput = elements.settlerRewardInput.value;
            const settlerEth = (settlerInput && settlerInput !== '')
                ? parseFloat(settlerInput)
                : (gasOracle.isReady() ? parseFloat(ethers.formatEther(gasOracle.getSettleCost())) : 0.001);
            newSellAmt = Math.max(0, balance - bountyEst - gasCompEth - settlerEth - 0.0001);
            symbol = 'ETH';
        } else {
            newSellAmt = Math.max(0, balance - bountyEst - 0.001);
            symbol = 'USDC';
        }

        if (newSellAmt <= 0) {
            showToast('Insufficient Balance', `Balance too low to cover swap overhead`, 'error');
            return;
        }

        elements.sellAmount.value = newSellAmt.toFixed(6);
        state.sellAmount = elements.sellAmount.value;
        autoCalculateBuyAmount();
        updateSwapButton();
        showToast('Amount Updated', `Sell amount reduced to ${newSellAmt.toFixed(symbol === 'ETH' ? 6 : 2)} ${symbol}`, 'info');
        return;
    }

    // Check risk acceptance
    if (!hasAcceptedRisk()) {
        try {
            await showRiskModal();
        } catch (e) {
            return; // User declined
        }
    }

    if (!state.sellAmount || !state.buyAmount) {
        return;
    }

    try {
        setButtonLoading(elements.swapBtn, true);

        // Parse amounts
        const sellAmountWei = parseTokenAmount(state.sellAmount, state.sellToken.decimals);
        const buyAmountWei = parseTokenAmount(state.buyAmount, state.buyToken.decimals);

        // Calculate min out with slippage (1e7 precision to match toleranceRange)
        const toleranceRange = Math.floor((state.settings.slippage / 100) * 1e7);
        let minOutWei = buyAmountWei - (buyAmountWei * BigInt(toleranceRange) / BigInt(10000000));

        // Account for fulfillment fee (contract deducts fee from fulfillAmt before comparing to minOut)
        // Fee is in 1e7 scale, e.g., 1000 = 0.01%
        const fulfillFee = BigInt(CONFIG.defaults.maxFee);
        minOutWei = minOutWei - (minOutWei * fulfillFee / BigInt(10000000));

        // Use a higher minFulfillLiquidity to ensure matcher provides enough
        const minFulfillLiquidity = buyAmountWei + (buyAmountWei * BigInt(500) / BigInt(10000)); // +5% buffer

        // Get values from inputs
        const expirationSeconds = parseInt(elements.expirationInput.value) || 30;
        const settlementTime = parseInt(elements.settlementTimeInput.value) || CONFIG.defaults.settlementTime;

        // Gas oracle is updated periodically - only update if not ready
        if (!gasOracle.isReady()) {
            await gasOracle.update(wallet.provider);
        }

        // Calculate notional for settler reward calculation
        const sellAmt = parseFloat(state.sellAmount);
        const notionalUsd = state.sellToken.symbol === 'ETH' ? sellAmt * state.currentPrice : sellAmt;

        // Calculate gas compensation (900k L2 gas + L1 data fee)
        // gasOracle uses its own effective gas price (baseFee + 15% tip)
        const gasCompWei = gasOracle.getMatchCost();
        const gasComp = parseFloat(ethers.formatEther(gasCompWei));

        // Calculate settler reward (includes 25% spread and low gas minimum)
        // Use max of: gas-based calculation OR 0.001% of notional
        const gasBasedSettlerRewardWei = gasOracle.getSettleCost();
        const gasBasedSettlerReward = parseFloat(ethers.formatEther(gasBasedSettlerRewardWei));
        const notionalBasedSettlerReward = (notionalUsd * 0.00001) / state.currentPrice; // 0.001% of notional in ETH
        const defaultSettlerReward = Math.max(gasBasedSettlerReward, notionalBasedSettlerReward);
        const settlerRewardInput = elements.settlerRewardInput.value;
        const settlerReward = settlerRewardInput && settlerRewardInput !== ''
            ? parseFloat(settlerRewardInput)
            : defaultSettlerReward;

        // Calculate price tolerated (using 1e18 precision to match oracle)
        const priceTolerated = (sellAmountWei * BigInt(10 ** 18)) / buyAmountWei;

        // Initial liquidity: max(10% of sellAmt, dispute gas cost / 0.01%)
        // 0.01% constraint means gas cost should be <= 0.01% of init liq
        // Uses floored gas cost for init liq (clamps baseFee to 0.001 gwei in low gas regime)
        const gasCostWei = gasOracle.getDisputeCostForInitLiq();
        const tenPercentSell = sellAmountWei * BigInt(10) / BigInt(100);
        let minInitLiq;
        if (state.sellToken.address === ethers.ZeroAddress) {
            // Selling ETH: minInitLiq = gasCost / 0.00008 = gasCost * 12500
            minInitLiq = gasCostWei * BigInt(12500);
        } else {
            // Selling USDC: convert gas cost to USD then to USDC units
            const gasCostEth = parseFloat(ethers.formatEther(gasCostWei));
            const gasCostUsd = gasCostEth * state.currentPrice;
            const minInitLiqUsd = gasCostUsd * 12500;  // gasCost / 0.008%
            minInitLiq = BigInt(Math.ceil(minInitLiqUsd * 1e6));
        }

        // Use manual initial liquidity if provided, otherwise use calculated
        const initLiqInput = elements.initialLiquidityInput.value;
        let initialLiquidity;
        if (initLiqInput && initLiqInput !== '' && initLiqInput !== 'auto') {
            // Manual input - parse based on sell token
            if (state.sellToken.address === ethers.ZeroAddress) {
                initialLiquidity = ethers.parseEther(initLiqInput);
            } else {
                initialLiquidity = BigInt(Math.floor(parseFloat(initLiqInput) * 1e6));
            }
        } else {
            initialLiquidity = tenPercentSell > minInitLiq ? tenPercentSell : minInitLiq;
        }
        // Escalation halt is 3x sell amount (in sellToken units)
        const escalationHalt = sellAmountWei * BigInt(3);

        // Calculate bounty based on settlement-time volatility
        // Get settlement-time σ as decimal (settlementTime already declared above)
        let volSettlement;
        if (volatility.lastKrakenVol !== null) {
            volSettlement = volatility.lastKrakenVol / 6.5; // already scaled to settlement time
        } else if (volatility.lastCandleVol !== null) {
            volSettlement = (volatility.lastCandleVol / 1.5) / Math.sqrt(60 / settlementTime); // remove 1.5x, scale 1-min to settlement time
        } else {
            volSettlement = 0.001; // fallback
        }

        let initLiqUsd;
        if (state.sellToken.address === ethers.ZeroAddress) {
            initLiqUsd = parseFloat(ethers.formatEther(initialLiquidity)) * state.currentPrice;
        } else {
            initLiqUsd = parseFloat(initialLiquidity.toString()) / 1e6;
        }

        // bountyStartAmt = 0.5 * vol * initLiq, min 0.0065%, capped at 0.2%
        const minBountyStartUsd = initLiqUsd * 0.000065; // 0.0065% floor
        const maxBountyStartUsd = initLiqUsd * 0.002; // 0.2% cap
        let bountyStartUsd = Math.max(0.5 * volSettlement * initLiqUsd, minBountyStartUsd);
        bountyStartUsd = Math.min(bountyStartUsd, maxBountyStartUsd);

        // totalAmtDeposited = max(0.15% of initLiq, 2 * bountyStartAmt)
        const minTotalUsd = initLiqUsd * 0.0015; // 0.15% floor
        const totalBountyUsd = Math.max(minTotalUsd, bountyStartUsd * 2);

        // Use USDC for bounty when selling USDC, ETH when selling ETH
        const isSellingUsdc = state.sellToken.address !== ethers.ZeroAddress;
        let bountyToken, bountyStartWei, bountyWei;
        if (isSellingUsdc) {
            // USDC bounty (6 decimals, 1 USDC = $1)
            bountyToken = CONFIG.tokens.USDC;
            bountyStartWei = BigInt(Math.floor(bountyStartUsd * 1e6));
            bountyWei = BigInt(Math.floor(totalBountyUsd * 1e6));
        } else {
            // ETH bounty (18 decimals)
            bountyToken = '0x0000000000000000000000000000000000000000';
            const bountyStartEth = bountyStartUsd / state.currentPrice;
            const totalBountyEth = totalBountyUsd / state.currentPrice;
            bountyStartWei = ethers.parseEther(bountyStartEth.toFixed(18));
            bountyWei = ethers.parseEther(totalBountyEth.toFixed(18));
        }

        const swapParams = {
            sellAmount: sellAmountWei.toString(),
            sellToken: state.sellToken.address,
            minOut: minOutWei.toString(),
            buyToken: state.buyToken.address,
            minFulfillLiquidity: minFulfillLiquidity.toString(),
            expirationSeconds: expirationSeconds,
            gasCompensation: gasComp,
            oracleParams: {
                settlerReward: ethers.parseEther(settlerReward.toFixed(18)).toString(),
                initialLiquidity: initialLiquidity.toString(),
                escalationHalt: escalationHalt.toString(),
                settlementTime: settlementTime,
                latencyBailout: CONFIG.defaults.latencyBailout,
                maxGameTime: CONFIG.defaults.maxGameTime,
                blocksPerSecond: 500,
                disputeDelay: CONFIG.defaults.disputeDelay,
                swapFee: CONFIG.defaults.swapFee,
                protocolFee: elements.delayModeToggle.checked ? 250 : 0,
                multiplier: 130,
                timeType: true
            },
            slippageParams: {
                priceTolerated: priceTolerated.toString(),
                toleranceRange: toleranceRange
            },
            fulfillFeeParams: {
                maxFee: CONFIG.defaults.maxFee,
                startingFee: CONFIG.defaults.startingFee,
                roundLength: CONFIG.defaults.roundLength,
                growthRate: CONFIG.defaults.growthRate,
                maxRounds: CONFIG.defaults.maxRounds
            },
            // BountyParams - use USDC when selling USDC, ETH when selling ETH
            bountyParams: {
                totalAmtDeposited: bountyWei.toString(),
                bountyStartAmt: bountyStartWei.toString(),
                roundLength: 1,
                bountyToken: bountyToken,
                bountyMultiplier: 11401,
                maxRounds: 20
            }
        };

        // Preflight checks on swapParams
        // Max sell amount limits
        if (swapParams.sellToken === ethers.ZeroAddress) {
            if (BigInt(swapParams.sellAmount) > ethers.parseEther('0.1')) {
                showToast('Limit Exceeded', 'Maximum sell amount is 0.1 ETH', 'error');
                return;
            }
        } else {
            if (BigInt(swapParams.sellAmount) > BigInt(300 * 1e6)) {
                showToast('Limit Exceeded', 'Maximum sell amount is 300 USDC', 'error');
                return;
            }
        }

        if (BigInt(swapParams.slippageParams.priceTolerated) === BigInt(0)) {
            showToast('Invalid Parameters', 'priceTolerated cannot be zero', 'error');
            return;
        }
        if (swapParams.slippageParams.toleranceRange === 0) {
            showToast('Invalid Parameters', 'toleranceRange cannot be zero - check slippage', 'error');
            return;
        }
        if (volatility.getRecommendedSlippage() === 0) {
            showToast('Volatility Error', 'Unable to calculate volatility - try again', 'error');
            return;
        }
        if (swapParams.expirationSeconds > 60) {
            showToast('Invalid Parameters', 'Expiration cannot exceed 60 seconds', 'error');
            return;
        }
        if (swapParams.oracleParams.settlementTime > 60) {
            showToast('Invalid Parameters', 'Settlement time cannot exceed 60 seconds', 'error');
            return;
        }
        if (swapParams.oracleParams.timeType && swapParams.oracleParams.settlementTime < 4) {
            showToast('Invalid Parameters', 'Settlement time must be at least 4 seconds', 'error');
            return;
        }
        if (!swapParams.oracleParams.timeType && swapParams.oracleParams.settlementTime < 2) {
            showToast('Invalid Parameters', 'Settlement time must be at least 2 blocks', 'error');
            return;
        }
        if (swapParams.oracleParams.maxGameTime > 1800) {
            showToast('Invalid Parameters', 'maxGameTime cannot exceed 1800', 'error');
            return;
        }
        if (BigInt(swapParams.oracleParams.settlerReward) > ethers.parseEther('0.01')) {
            showToast('Invalid Parameters', 'Settler reward cannot exceed 0.01 ETH', 'error');
            return;
        }
        if (swapParams.oracleParams.latencyBailout > 60) {
            showToast('Invalid Parameters', 'Latency bailout cannot exceed 60 seconds', 'error');
            return;
        }
        if (swapParams.oracleParams.blocksPerSecond !== 500) {
            showToast('Invalid Parameters', 'blocksPerSecond must be 500', 'error');
            return;
        }
        if (swapParams.oracleParams.swapFee > 10000 || swapParams.oracleParams.protocolFee > 10000) {
            showToast('Invalid Parameters', 'swapFee and protocolFee cannot exceed 10000', 'error');
            return;
        }
        if (swapParams.oracleParams.multiplier > 300) {
            showToast('Invalid Parameters', 'multiplier cannot exceed 300', 'error');
            return;
        }
        // initialLiquidity must be >= 9.9% of sellAmount and <= sellAmount
        const initLiqCheck = BigInt(swapParams.oracleParams.initialLiquidity);
        const sellAmtCheck = BigInt(swapParams.sellAmount);
        const minInitLiqCheck = sellAmtCheck * BigInt(99) / BigInt(1000); // 9.9%
        if (initLiqCheck < minInitLiqCheck) {
            const pct = (Number(initLiqCheck) / Number(sellAmtCheck) * 100).toFixed(2);
            showToast('Invalid Parameters', `Initial liquidity (${pct}%) must be at least 9.9% of sell amount`, 'error');
            return;
        }
        if (initLiqCheck > sellAmtCheck) {
            showToast('Invalid Parameters', 'Initial liquidity cannot exceed sell amount', 'error');
            return;
        }
        if (swapParams.fulfillFeeParams.maxFee > 20000) {
            showToast('Invalid Parameters', 'Fulfillment fee cannot exceed 0.2%', 'error');
            return;
        }
        if (swapParams.gasCompensation > 0.01) {
            showToast('Invalid Parameters', 'Gas compensation cannot exceed 0.01 ETH', 'error');
            return;
        }

        // Check bounty limits based on token
        const bountyAmt = BigInt(swapParams.bountyParams.totalAmtDeposited);
        const bountyTokenAddr = swapParams.bountyParams.bountyToken;
        if (bountyTokenAddr === '0x0000000000000000000000000000000000000000') {
            // ETH: max 0.05 ETH
            if (bountyAmt > ethers.parseEther('0.05')) {
                showToast('Invalid Parameters', 'ETH bounty cannot exceed 0.05 ETH', 'error');
                return;
            }
        } else if (bountyTokenAddr === CONFIG.tokens.USDC) {
            // USDC: max 100 USDC (6 decimals)
            if (bountyAmt > BigInt(100 * 1e6)) {
                showToast('Invalid Parameters', 'USDC bounty cannot exceed 100 USDC', 'error');
                return;
            }
        } else if (bountyTokenAddr === CONFIG.tokens.OP) {
            // OP: max 300 OP (18 decimals)
            if (bountyAmt > ethers.parseEther('300')) {
                showToast('Invalid Parameters', 'OP bounty cannot exceed 300 OP', 'error');
                return;
            }
        }

        // Check sellAmount + overhead doesn't exceed balance (use cached balance)
        const sellAmtBig = BigInt(swapParams.sellAmount);
        const balanceNum = parseFloat(state.sellToken.balance);
        if (state.sellToken.address === ethers.ZeroAddress) {
            // ETH: need sellAmt + bounty + gasComp + settlerReward
            const rawBalance = ethers.parseEther(balanceNum.toFixed(18));
            const gasCompWei = ethers.parseEther(swapParams.gasCompensation.toFixed(18));
            const settlerWei = BigInt(swapParams.oracleParams.settlerReward);
            const totalNeeded = sellAmtBig + bountyAmt + gasCompWei + settlerWei;
            if (totalNeeded > rawBalance) {
                const shortfall = parseFloat(ethers.formatEther(totalNeeded - rawBalance));
                showToast('Insufficient Balance', `Need ${shortfall.toFixed(6)} more ETH for swap + overhead`, 'error');
                return;
            }
        } else {
            // USDC: need sellAmt + bounty (if bounty is USDC)
            if (bountyTokenAddr === CONFIG.tokens.USDC) {
                const rawBalance = BigInt(Math.floor(balanceNum * 1e6));
                const totalNeeded = sellAmtBig + bountyAmt;
                if (totalNeeded > rawBalance) {
                    const shortfall = Number(totalNeeded - rawBalance) / 1e6;
                    showToast('Insufficient Balance', `Need ${shortfall.toFixed(4)} more USDC for swap + bounty`, 'error');
                    return;
                }
            }
        }

        // When selling USDC, still need ETH for settlerReward + gasCompensation
        if (state.sellToken.address !== ethers.ZeroAddress) {
            const ethBalanceNum = parseFloat(state.buyToken.balance);
            const ethBalanceWei = ethers.parseEther(ethBalanceNum.toFixed(18));
            const gasCompWei = ethers.parseEther(swapParams.gasCompensation.toFixed(18));
            const settlerWei = BigInt(swapParams.oracleParams.settlerReward);
            const ethNeeded = gasCompWei + settlerWei;
            if (ethNeeded > ethBalanceWei) {
                const shortfall = parseFloat(ethers.formatEther(ethNeeded - ethBalanceWei));
                showToast('Insufficient ETH', `Need ${shortfall.toFixed(6)} more ETH for settler reward + gas compensation`, 'error');
                return;
            }
        }

        console.log('Creating swap with params:', swapParams);

        const result = await openSwap.createSwap(swapParams);

        showToast('Swap Created', `Transaction confirmed!`, 'success');

        // Start tracking the swap if we got a swapId
        if (result && result.swapId) {
            // Format minOut for display
            const minOutFormatted = formatTokenAmount(minOutWei.toString(), state.buyToken.decimals);
            statusTracker.startTracking(result.swapId, result.txHash, {
                sellAmount: state.sellAmount,
                sellToken: state.sellToken.symbol,
                buyToken: state.buyToken.symbol,
                minReceived: minOutFormatted,
                gasCompensation: swapParams.gasCompensation,
                settlerReward: swapParams.oracleParams.settlerReward,
                bountyParams: {
                    ...swapParams.bountyParams,
                    ethPrice: state.currentPrice
                }
            });

            // Scroll to status tracker
            setTimeout(() => {
                const statusEl = document.getElementById('statusTracker');
                if (statusEl) {
                    statusEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 100);
        }

        // Reset form
        state.sellAmount = '';
        state.buyAmount = '';
        elements.sellAmount.value = '';
        elements.buyAmount.value = '';
        elements.initialLiquidityInput.value = ''; // Reset to auto-calculate
        elements.settlerRewardInput.value = ''; // Reset to auto-calculate
        elements.swapDetails.classList.remove('visible');
        updateSwapButton();
        updateBalances('pending');

    } catch (error) {
        console.error('Swap error:', error);
        showToast('Swap Failed', error.message || 'Transaction failed', 'error');
    } finally {
        setButtonLoading(elements.swapBtn, false);
        updateSwapButton();
    }
}

/**
 * Toggle advanced settings
 */
function toggleAdvanced() {
    elements.advancedToggle.classList.toggle('open');
    elements.advancedPanel.classList.toggle('open');
}

/**
 * Toggle cost breakdown panel
 */
function toggleCostBreakdown() {
    elements.costBreakdownToggle.classList.toggle('expanded');
    elements.costBreakdownPanel.classList.toggle('visible');
}

/**
 * Update gas debug display with L1/L2 breakdown
 */
function updateGasDebug() {
    if (!gasOracle.isReady()) return;

    try {
        const params = gasOracle.getRawParams();
        const swapBreakdown = gasOracle.getSwapCostBreakdown();
        const matchBreakdown = gasOracle.getMatchCostBreakdown();
        const settleBreakdown = gasOracle.getSettleCostBreakdown();

        // Format wei to gwei with appropriate precision
        const formatGwei = (wei) => {
            if (wei === null || wei === undefined) return '—';
            const num = typeof wei === 'bigint' ? Number(wei) : wei;
            const gwei = num / 1e9;
            if (gwei < 0.001) return `${num} wei`;
            if (gwei < 1) return `${gwei.toFixed(6)} gwei`;
            return `${gwei.toFixed(3)} gwei`;
        };

        // Format ETH with appropriate precision
        const formatEth = (wei) => {
            if (wei === null || wei === undefined) return '—';
            const num = typeof wei === 'bigint' ? Number(wei) : wei;
            if (num === 0) return '0 ETH';
            const eth = num / 1e18;
            if (eth < 0.000001) return `${(num / 1e9).toFixed(4)} gwei`;  // Show in gwei for very small
            if (eth < 0.0001) return `${(eth * 1e6).toFixed(4)} µETH`;
            return `${eth.toFixed(6)} ETH`;
        };

        // Update base fee info
        elements.gasDebugBaseFee.textContent = formatGwei(params.baseFee);
        elements.gasDebugL1BaseFee.textContent = formatGwei(params.l1BaseFee);
        elements.gasDebugEffective.textContent = formatGwei(params.effectiveGasPrice);
        elements.gasDebugLowGas.textContent = params.isLowGasRegime ? 'YES (< 20k wei)' : 'No';

        // Update swap creation costs
        elements.gasDebugSwapL2.textContent = formatEth(swapBreakdown.l2Cost);
        elements.gasDebugSwapL1.textContent = formatEth(swapBreakdown.l1Cost);
        elements.gasDebugSwapTotal.textContent = formatEth(swapBreakdown.total);

        // Update match costs
        elements.gasDebugMatchL2.textContent = formatEth(matchBreakdown.l2Cost);
        elements.gasDebugMatchL1.textContent = formatEth(matchBreakdown.l1Cost);
        elements.gasDebugMatchTotal.textContent = formatEth(matchBreakdown.total);

        // Update settle costs
        elements.gasDebugSettleL2.textContent = formatEth(settleBreakdown.l2Cost);
        elements.gasDebugSettleL1.textContent = formatEth(settleBreakdown.l1Cost);
        elements.gasDebugSettleTotal.textContent = formatEth(settleBreakdown.final);

    } catch (e) {
        console.error('Error updating gas debug:', e);
    }
}

/**
 * Update cost breakdown estimates
 * - Fulfillment fee: from config (e.g., 0.02%)
 * - Initial reporter reward: ~80% of IQR * (initial liquidity / swap notional)
 *   Default initial liquidity is 10% of swap, so: 0.8 * IQR * 0.10 = 0.08 * IQR
 * - Other gas: ~1M gas converted to USD, then as % of swap amount
 */
async function updateCostBreakdown() {
    if (!state.sellAmount || !state.currentPrice) {
        state.estTotalCostPct = null;
        elements.estTotalCost.textContent = '-';
        elements.costFulfillmentFee.textContent = '-';
        elements.costReporterReward.textContent = '-';
        elements.costOtherGas.textContent = '-';
        return;
    }

    try {
        const sellAmt = parseFloat(state.sellAmount);
        if (isNaN(sellAmt) || sellAmt <= 0) return;

        // Calculate swap notional in USD
        let swapNotionalUsd;
        if (state.sellToken.address === ethers.ZeroAddress) {
            swapNotionalUsd = sellAmt * state.currentPrice;
        } else {
            swapNotionalUsd = sellAmt; // USDC
        }

        // 1. Fulfillment fee: max(minFee, min(maxFee, 25% of settlement-time volatility from Kraken))
        const minFeePct = CONFIG.defaults.startingFee / 100000; // e.g., 750 -> 0.0075%
        const maxFeePct = CONFIG.defaults.maxFee / 100000; // e.g., 2000 -> 0.02%
        let fulfillmentFeePct = maxFeePct;
        if (volatility.lastKrakenVol !== null) {
            const volSettlement = volatility.lastKrakenVol / 6.5; // Convert 6.5σ to raw σ (already scaled to settlement time)
            const volBasedFeePct = 0.25 * volSettlement * 100; // 25% of vol as percentage
            fulfillmentFeePct = Math.max(minFeePct, Math.min(maxFeePct, volBasedFeePct));
        }
        // Apply 1 round of growth (1.2x) to estimate fee at match time, capped at maxFee
        const growthMultiplier = CONFIG.defaults.growthRate / 10000; // 12000 -> 1.2x
        fulfillmentFeePct = Math.min(fulfillmentFeePct * growthMultiplier, maxFeePct);

        // 2. Initial reporter reward: bountyStartAmt = 0.5 * vol * initLiq (same vol as fulfillment fee)
        // Get initial liquidity ratio from input value or placeholder
        let initLiqRatio = 0.10; // default
        const initLiqInput = elements.initialLiquidityInput.value || elements.initialLiquidityInput.placeholder;
        if (initLiqInput && initLiqInput !== '' && initLiqInput !== 'auto' && state.sellAmount) {
            const initLiqValue = parseFloat(initLiqInput);
            if (!isNaN(initLiqValue) && initLiqValue > 0) {
                initLiqRatio = initLiqValue / sellAmt;
            }
        }

        // Use same Kraken volatility as fulfillment fee for consistency
        const settlementTime = parseInt(elements.settlementTimeInput.value) || CONFIG.defaults.settlementTime;
        let volSettlement;
        if (volatility.lastKrakenVol !== null) {
            volSettlement = volatility.lastKrakenVol / 6.5;
        } else if (volatility.lastCandleVol !== null) {
            volSettlement = (volatility.lastCandleVol / 1.5) / Math.sqrt(60 / settlementTime);
        } else {
            return;
        }
        // Expected bounty payout ~65% of vol * initLiq (starts at 50%, grows over time)
        const minBountyPct = 0.0065 * initLiqRatio; // 0.0065% of initLiq
        const maxBountyPct = 0.2 * initLiqRatio; // 0.2% of initLiq (cap is 2x start, so max payout ~0.4%)
        let reporterRewardPct = 0.65 * volSettlement * initLiqRatio * 100;
        reporterRewardPct = Math.max(minBountyPct, Math.min(maxBountyPct * 2, reporterRewardPct));

        // 3. Other gas: swap creation gas + gasCompensation + settlerReward
        if (!gasOracle.isReady()) return;
        // Swap creation: ~550k gas using baseFee from gasOracle + typical tip
        const baseFee = gasOracle.baseFee || BigInt(0);
        const tip = BigInt(100000); // 0.0001 gwei typical tip on Optimism
        const effectiveGasPrice = baseFee + tip;
        const swapCreationGas = BigInt(550000);
        const swapCreationCostWei = swapCreationGas * effectiveGasPrice;
        const swapCreationCostEth = parseFloat(ethers.formatEther(swapCreationCostWei));
        // gasCompensation from gas oracle
        const gasCompWei = gasOracle.getMatchCost();
        const gasCompEth = parseFloat(ethers.formatEther(gasCompWei));
        // settlerReward: max of gas-based OR 0.001% of notional (same as swap params)
        const gasBasedSettlerRewardWei = gasOracle.getSettleCost();
        const gasBasedSettlerRewardEth = parseFloat(ethers.formatEther(gasBasedSettlerRewardWei));
        const notionalBasedSettlerRewardEth = (swapNotionalUsd * 0.00001) / state.currentPrice;
        const settlerRewardEth = Math.max(gasBasedSettlerRewardEth, notionalBasedSettlerRewardEth);
        // Total gas cost
        const totalGasEth = swapCreationCostEth + gasCompEth + settlerRewardEth;
        const gasCostUsd = totalGasEth * state.currentPrice;
        const otherGasPct = (gasCostUsd / swapNotionalUsd) * 100;

        // Total
        const totalPct = fulfillmentFeePct + reporterRewardPct + otherGasPct;
        state.estTotalCostPct = totalPct;

        // Update UI
        elements.estTotalCost.textContent = `~${totalPct.toFixed(3)}%`;
        elements.costFulfillmentFee.textContent = `${fulfillmentFeePct.toFixed(3)}%`;
        elements.costReporterReward.textContent = `${reporterRewardPct.toFixed(3)}%`;
        elements.costOtherGas.textContent = `${otherGasPct.toFixed(3)}%`;

        // Update swap button now that cost is calculated
        updateSwapButton();

    } catch (e) {
        console.error('Error updating cost breakdown:', e);
    }
}

/**
 * Handle load order by ID
 */
async function handleLoadOrder() {
    const swapId = elements.loadOrderInput.value.trim();

    if (!swapId) {
        showToast('Error', 'Please enter a Swap ID', 'error');
        return;
    }

    if (!wallet.isConnected()) {
        showToast('Error', 'Please connect your wallet first', 'error');
        return;
    }

    try {
        // Check if swap ID is valid (must be < nextSwapId and > 0)
        const nextId = await openSwap.getNextSwapId();
        const swapIdNum = parseInt(swapId);

        if (isNaN(swapIdNum) || swapIdNum < 1 || swapIdNum >= Number(nextId)) {
            showToast('Error', 'Swap not found', 'error');
            return;
        }

        // Fetch the swap
        const swap = await openSwap.getSwap(swapId);

        // Check if swap exists (active is set to true on creation)
        if (!swap.active && !swap.matched && !swap.finished && !swap.cancelled) {
            showToast('Error', 'Swap not found', 'error');
            return;
        }

        // Check if we are the swapper
        if (swap.swapper.toLowerCase() !== wallet.address.toLowerCase()) {
            showToast('Error', 'This swap belongs to a different address', 'error');
            return;
        }

        // Check if already finished
        if (swap.finished) {
            showToast('Info', `Swap #${swapId} has already been executed`, 'info');
            return;
        }

        // Check if cancelled
        if (swap.cancelled) {
            showToast('Info', `Swap #${swapId} was cancelled`, 'info');
            return;
        }

        // Save to localStorage
        openSwap.saveSwapId(swapId, wallet.address);

        // Clear input and reload orders
        elements.loadOrderInput.value = '';
        showToast('Success', `Loaded swap #${swapId}`, 'success');
        loadUserOrders();

    } catch (error) {
        console.error('Load order error:', error);
        showToast('Error', 'Failed to load swap. Check the ID.', 'error');
    }
}

/**
 * Render orders list from state (applies optimistic updates)
 */
function renderOrdersList() {
    if (!elements.ordersList || state.userOrders.length === 0) return;

    // Apply optimistic matched updates with bailout info
    const ordersToRender = state.userOrders.map(order => {
        if (state.matchedSwapIds.has(order.swapId)) {
            const bailoutDeadline = state.matchedSwapIds.get(order.swapId);
            const now = Math.floor(Date.now() / 1000);
            const latencyTimeRemaining = bailoutDeadline ? Math.max(0, bailoutDeadline - now) : null;
            const canBailOut = latencyTimeRemaining !== null && latencyTimeRemaining <= 0;
            return {
                ...order,
                matched: true,
                bailoutInfo: {
                    canBailOut: canBailOut,
                    canSettle: false,
                    countdown: latencyTimeRemaining,
                    reason: canBailOut ? 'No initial report' : 'Awaiting report',
                    hasInitialReport: false,
                    isDistributed: false,
                    latencyBailoutAvailable: canBailOut,
                    maxGameTimeBailoutAvailable: false,
                    latencyTimeRemaining: latencyTimeRemaining,
                    maxGameTimeRemaining: null, // Unknown in optimistic mode
                    reportId: order.reportId
                }
            };
        }
        return order;
    });

    elements.ordersList.innerHTML = ordersToRender.map(order => renderOrderRow(order)).join('');

    // Add action handlers
    elements.ordersList.querySelectorAll('.order-action-btn').forEach(btn => {
        const action = btn.dataset.action;
        const swapId = btn.dataset.swapId;
        const reportId = btn.dataset.reportId;

        btn.addEventListener('click', async () => {
            if (action === 'cancel') {
                await handleCancel(swapId, btn);
            } else if (action === 'bailout') {
                await handleBailOut(swapId, btn);
            } else if (action === 'settle') {
                await handleSettle(reportId, btn);
            }
        });
    });
}

/**
 * Update countdown displays without re-fetching (called every second)
 */
function updateCountdowns() {
    let needsRerender = false;
    document.querySelectorAll('.order-bailout-status.countdown').forEach(el => {
        const text = el.textContent;

        // Parse various countdown formats: "Xs", "Xm Ys", "Xh Ym"
        let totalSeconds = 0;
        const hoursMatch = text.match(/(\d+)h/);
        const minsMatch = text.match(/(\d+)m/);
        const secsMatch = text.match(/(\d+)s/);

        if (hoursMatch) totalSeconds += parseInt(hoursMatch[1]) * 3600;
        if (minsMatch) totalSeconds += parseInt(minsMatch[1]) * 60;
        if (secsMatch) totalSeconds += parseInt(secsMatch[1]);

        if (totalSeconds > 0) {
            totalSeconds--;
            if (totalSeconds <= 0) {
                // Countdown finished - need full re-render
                needsRerender = true;
            } else {
                // Extract prefix (everything before the time)
                const prefix = text.replace(/\d+[hms]\s*/g, '').replace(/\s+$/, '');
                el.textContent = `${prefix} ${formatCountdown(totalSeconds)}`;
            }
        }
    });
    if (needsRerender) {
        loadUserOrders();
    }
}

/**
 * Load user orders
 */
async function loadUserOrders() {
    if (!wallet.isConnected()) {
        elements.ordersList.innerHTML = `
            <div class="empty-state">
                <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <line x1="3" y1="9" x2="21" y2="9"></line>
                    <line x1="9" y1="21" x2="9" y2="9"></line>
                </svg>
                <h3>Connect wallet</h3>
                <p>Connect your wallet to view your orders</p>
            </div>
        `;
        return;
    }

    try {
        const orders = await openSwap.getUserSwaps(wallet.address);

        // Clear optimistic flags for orders that are now confirmed matched
        orders.forEach(order => {
            if (order.matched && state.matchedSwapIds.has(order.swapId)) {
                state.matchedSwapIds.delete(order.swapId);
            }
        });

        state.userOrders = orders;

        if (orders.length === 0) {
            elements.ordersList.innerHTML = `
                <div class="empty-state">
                    <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="3" y1="9" x2="21" y2="9"></line>
                        <line x1="9" y1="21" x2="9" y2="9"></line>
                    </svg>
                    <h3>No orders yet</h3>
                    <p>Create your first swap to get started</p>
                </div>
            `;
            return;
        }

        renderOrdersList();
    } catch (error) {
        console.error('Failed to load user orders:', error);
        showToast('Error', 'Failed to load orders', 'error');
    }
}


/**
 * Render order row
 */
function renderOrderRow(order) {
    const sellToken = getToken(order.sellToken) || { symbol: 'UNK', decimals: 18, logo: null };
    const buyToken = getToken(order.buyToken) || { symbol: 'UNK', decimals: 18, logo: null };

    const sellAmount = formatTokenAmount(order.sellAmt.toString(), sellToken.decimals);
    const buyAmount = formatTokenAmount(order.minOut.toString(), buyToken.decimals);

    let status = 'active';
    let statusText = 'Active';

    if (order.finished) {
        status = 'completed';
        statusText = 'Completed';
    } else if (order.matched) {
        status = 'matched';
        statusText = 'Matched';
    } else if (order.cancelled) {
        status = 'completed';
        statusText = 'Cancelled';
    }

    const canCancel = order.active && !order.matched && !order.cancelled && !order.finished;

    // Use bailoutInfo if available, otherwise fall back to simple check
    const bailoutInfo = order.bailoutInfo;
    const canBailOut = bailoutInfo ? bailoutInfo.canBailOut : (order.matched && !order.finished && !order.cancelled);

    const sellIconHtml = sellToken.logo
        ? `<img src="${sellToken.logo}" alt="${sellToken.symbol}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span style="display:none">${sellToken.symbol.slice(0, 2)}</span>`
        : `<span>${sellToken.symbol.slice(0, 2)}</span>`;

    const buyIconHtml = buyToken.logo
        ? `<img src="${buyToken.logo}" alt="${buyToken.symbol}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span style="display:none">${buyToken.symbol.slice(0, 2)}</span>`
        : `<span>${buyToken.symbol.slice(0, 2)}</span>`;

    // Build bailout/settle status display for matched orders
    let statusInfoHtml = '';
    const canSettle = bailoutInfo?.canSettle || false;
    const reportId = bailoutInfo?.reportId?.toString() || order.reportId?.toString();

    if (order.matched && !order.finished && bailoutInfo) {
        // Primary status line
        if (bailoutInfo.reason) {
            if (canBailOut) {
                // Bailout available - show reason as warning
                statusInfoHtml = `<div class="order-bailout-status available">${bailoutInfo.reason}</div>`;
            } else if (canSettle) {
                // Ready to settle
                statusInfoHtml = `<div class="order-bailout-status available">${bailoutInfo.reason}</div>`;
            } else if (bailoutInfo.countdown !== null && bailoutInfo.countdown > 0) {
                // Show countdown (either latency bailout or settlement countdown)
                statusInfoHtml = `<div class="order-bailout-status countdown">${bailoutInfo.reason} ${formatCountdown(bailoutInfo.countdown)}</div>`;
            } else {
                statusInfoHtml = `<div class="order-bailout-status">${bailoutInfo.reason}</div>`;
            }
        }

        // Also show maxGameTime as backup bailout countdown (if not already bailing out)
        if (!canBailOut && bailoutInfo.maxGameTimeRemaining !== null && bailoutInfo.maxGameTimeRemaining > 0) {
            statusInfoHtml += `<div class="order-bailout-status countdown" style="opacity: 0.7; font-size: 10px;">Safety bailout: ${formatCountdown(bailoutInfo.maxGameTimeRemaining)}</div>`;
        }
    }

    return `
        <div class="order-row">
            <div class="order-pair">
                <div class="order-pair-icons">
                    <div class="token-icon">${sellIconHtml}</div>
                    <div class="token-icon">${buyIconHtml}</div>
                </div>
                <span>${sellToken.symbol}/${buyToken.symbol}</span>
            </div>
            <div class="order-amount">${sellAmount}</div>
            <div class="order-amount">${buyAmount}</div>
            <div>
                <span class="order-status ${status}">${statusText}</span>
                ${statusInfoHtml}
            </div>
            <div class="order-actions">
                ${canCancel ? `<button class="order-action-btn danger" data-action="cancel" data-swap-id="${order.swapId}">Cancel</button>` : ''}
                ${canSettle ? `<button class="order-action-btn success" data-action="settle" data-report-id="${reportId}">Settle</button>` : ''}
                ${canBailOut ? `<button class="order-action-btn" data-action="bailout" data-swap-id="${order.swapId}">Bail Out</button>` : ''}
            </div>
        </div>
    `;
}

/**
 * Format countdown seconds to human readable string
 */
function formatCountdown(seconds) {
    if (seconds <= 0) return 'now';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return `${mins}m ${secs}s`;
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hours}h ${remainMins}m`;
}

/**
 * Handle cancel order
 */
async function handleCancel(swapId, btn) {
    try {
        setButtonLoading(btn, true);
        await openSwap.cancelSwap(swapId);
        showToast('Order Cancelled', `Order #${swapId} has been cancelled`, 'success');
        loadUserOrders();
        // Refresh balances
        updateBalances('pending');
        setTimeout(() => updateBalances('pending'), 1000);
        // Hide status tracker if this was the tracked swap
        if (statusTracker.swapId === swapId) {
            statusTracker.hide();
        }
    } catch (error) {
        console.error('Cancel error:', error);
        showToast('Cancel Failed', error.message || 'Transaction failed', 'error');
    } finally {
        setButtonLoading(btn, false, 'Cancel');
    }
}

/**
 * Handle bail out
 */
async function handleBailOut(swapId, btn) {
    try {
        setButtonLoading(btn, true);
        await openSwap.bailOut(swapId);
        showToast('Bail Out Success', `Order #${swapId} bail out completed`, 'success');
        loadUserOrders();
        statusTracker.hide();
    } catch (error) {
        console.error('Bail out error:', error);
        showToast('Bail Out Failed', error.message || 'Transaction failed', 'error');
    } finally {
        setButtonLoading(btn, false, 'Bail Out');
    }
}

/**
 * Handle settle report
 */
async function handleSettle(reportId, btn) {
    try {
        setButtonLoading(btn, true);
        await openSwap.settleReport(reportId);
        showToast('Settlement Success', 'Report settled, swap executed!', 'success');
        loadUserOrders();
        updateBalances('pending');
        setTimeout(() => updateBalances('pending'), 2000);
    } catch (error) {
        console.error('Settle error:', error);
        showToast('Settlement Failed', error.message || 'Transaction failed', 'error');
    } finally {
        setButtonLoading(btn, false, 'Settle');
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', init);
