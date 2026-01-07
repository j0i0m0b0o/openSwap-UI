# openSwap UI

A web interface for openSwap — an oracle-powered token swap protocol with trust-minimized price discovery through [openOracle](https://openprices.gitbook.io/openoracle-docs).

## Overview

openSwap enables ETH/USDC swaps using an optimistic oracle mechanism instead of traditional AMM liquidity pools. Prices are determined through a decentralized reporting and dispute game, providing MEV-resistant execution with transparent pricing.

### Key Features

- **Oracle-Powered Swaps**: Trade at oracle-determined prices rather than AMM curves
- **Trust-Minimized**: Price discovery through openOracle's reporting and dispute mechanism
- **Real-Time Status Tracking**: Live updates on swap lifecycle (matched, initial report, disputes, settlement, execution)
- **Volatility Monitoring**: Auto-calculated slippage based on market volatility
- **Gas Optimization**: L1+L2 gas cost estimation for Optimism

## Architecture

```
js/
├── app.js           # Main application logic and UI coordination
├── config.js        # Network configs, contract addresses, default parameters
├── contract.js      # openSwap contract interactions
├── gasOracle.js     # L1/L2 gas price tracking for Optimism
├── price.js         # Coinbase WebSocket price feed
├── statusTracker.js # Real-time swap status monitoring via event polling
├── tokens.js        # Token definitions (ETH, USDC)
├── ui.js            # UI utilities (toasts, modals, formatting)
├── volatility.js    # Volatility calculation from Kraken trades + candles
└── wallet.js        # MetaMask wallet connection management
```

## How It Works

1. **Create Swap**: User specifies amount to sell; fee grows over time until matched
2. **Matcher Fulfills**: A matcher locks liquidity and triggers the oracle game
3. **Initial Report**: Reporter submits price claim with collateral
4. **Dispute Window**: Anyone can dispute with counter-claim (optional)
5. **Settlement**: After settlement time (4s), undisputed price is finalized
6. **Execution**: Swap executes at settled price, tokens transferred

### Fees & Costs

- **Fulfillment Fee**: 0.0075% - 0.02% (grows with time if unmatched)
- **Gas Compensation**: Paid to matcher for execution gas
- **Bounty**: Paid to initial reporter to play oracle game

## Contracts

### Optimism (Production)
- **openSwap**: `0x75bC29FCf9aa8255B139574Ca66ec216B108573F`
- **openOracle**: `0xf3CCE3274c32f1F344Ba48336D5EFF34dc6E145f`
- **oracleBounty**: `0x971F2EE9a8ccDc455fd39403788C75bfd58dA321`

## Running Locally

1. Clone the repository
2. Serve the files with any static HTTP server:

```bash
# Python
python3 server.py

```

3. Open `http://localhost:8080` in your browser
4. Connect MetaMask and switch to Optimism network

## Requirements

- Modern browser with ES modules support
- MetaMask or compatible Web3 wallet
- ETH for gas + swap amount (or USDC if selling USDC)

## Safety

- **Experimental Software**: This protocol is experimental. Use at your own risk.
- **Smart Contract Risk**: Contracts may contain bugs or vulnerabilities
- **Oracle Risk**: Price depends on reporter/disputer game outcomes
- **Irreversible**: Transactions cannot be undone once confirmed

## License

MIT License - see [LICENSE](LICENSE) file for details.
