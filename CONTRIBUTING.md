# Contributing to the Solana TSL Engine

Thank you for your interest in contributing to the High-Frequency Solana Trading & Trailing Stop-Loss Engine. This document outlines the core logic, execution strategies and parameter configurations to help you understand the architecture before submitting a Pull Request.

---

## 🧠 Core Architecture & TSL Logic

The engine is built on a highly decoupled architecture to ensure zero-latency execution. The core workflow is split between the `BuyManager`, `SellManager`, and the `SolanaSwapEngine`.

### How the Trailing Stop-Loss (TSL) Works
The Trailing Stop-Loss logic is housed within `src/logic/SellManager.ts`. It does not rely on static take-profit levels; instead, it dynamically tracks the peak value of a token to lock in profits during highly volatile Solana market swings.

1. **High-Watermark Tracking:** For every price tick received, the engine compares the current price against the token's historical peak (`highWatermark`). If the current price is higher, the watermark is updated and saved to disk via an atomic write in the `PositionStore`.
2. **Mathematical Boundary:** If $P_t > P_{max}$, then $P_{max} = P_t$. The sell trigger condition is defined as:
  $$P_t \le P_{max} \times \left(1 - \frac{\text{TrailingStop}}{100}\right)$$
3. **Execution:** If `dropPct` meets or exceeds the configured threshold, the `SellManager` instantly applies a `sellLock` (to prevent duplicate WSS triggers) and fires the market sell transaction.

### Handling Stealth Launches (Zero-Price Entry)
If a token is purchased during a stealth launch and the RPC initially reports a $0 price, the `BuyManager` triggers a **High-Frequency Recovery Loop**. It pings the oracle every 2 seconds until a valid price is established, at which point it instantly arms the TSL.

---

## ⚙️ Modifying Stop-Loss Parameters

The bot is designed to be fully configurable without needing to recompile the TypeScript logic. All core parameters are routed through `config/index.ts`.

To modify the Trailing Stop-Loss or execution sizing, adjust the following variables in your `.env` file:

* `TRAILING_STOP=20` 
  *(The percentage the token must drop from its absolute peak to trigger a sell. Example: `20` = 20% trailing stop).*
* `SLIPPAGE=5` 
  *(The maximum allowed slippage percentage during the Jupiter swap).*
* `MAX_POSITIONS=5` 
  *(The absolute limit on concurrent active trades to protect your bankroll).*
* `AMOUNT=0.02` 
  *(The fixed SOL allocation per trade).*

---

## 📡Codebase Philosophy, Oracle Polling & Execution Strategies

Speed is the ultimate edge on Solana. This bot utilizes a hybrid data strategy to bypass rate limits while maintaining millisecond reaction times.

### 1. Dual-Key Jupiter Polling (`DEXPriceMonitor.ts`)
Jupiter's free tier is strictly capped at 1 Request Per Second (RPS). To prevent the price-monitoring engine from rate-limiting the trade-execution engine, the load is split:
* **The Polling Engine** uses the `JUPITER_PRICE_API_KEY` to track active positions.
* **The Swap Engine** uses the `JUPITER_QUOTE_API_KEY` to execute the actual trades.
* **The Smart Valve:** The `DEXPriceMonitor` utilizes a "Smart Valve" cooldown. If multiple WSS events fire simultaneously, the valve buffers the requests and flushes them as a batch query based on the `POLLING_INTERVAL_MS` (default `1100`ms) to prevent HTTP 429 cascades.

### 2. Helius WSS Dump Detection
While Jupiter handles the global oracle pricing, the bot maintains active WebSocket `onLogs` listeners via Helius. This acts as an instant "doorbell." The moment a large trade touches a token's liquidity pool, the WSS fires, forcing the Smart Valve to evaluate the TSL before the standard 1.1s polling interval even ticks.

### 3. Helius Staked Sender Tunnel
Standard public RPCs are too slow for volatile memecoin trading. The `SolanaSwapEngine` decompiles the Jupiter transaction, injects a static **0.0002 SOL Jito Base Tip**, and routes the transaction directly to East Coast Block Builders using the `HELIUS_SENDER_URL`. 

### 4. The Latency Reality (The Quest for True 0ms)
While this project leverages ultra-fast Helius WebSockets for localized pool state tracking and utilizes direct-to-validator Anycast tunnels (`sender.helius-rpc.com`), **it is critical to note that this system does not achieve true, hardware-level 0ms execution.** * **Current Constraints:** Network jitter, asynchronous Node.js event-loop scheduling, and API round-trip times (RTT) for execution quotes add structural latency. 
* **Active Research:** We are constantly studying market microstructure, RPC delta variances, and advanced memory management techniques to eliminate microsecond bottlenecks. Contributions aimed at optimizing memory allocations, reducing serialization overhead, or streamlining runtime execution paths are highly prioritized.
---

## 🛠️ Development & Pull Request Guidelines

1. **Keep the Logic Decoupled:** Do not merge UI/Telegram alert logic directly into the `SolanaSwapEngine`. Keep telemetry routed through the `EventEmitter`.
2. **Preserve Atomic Writes:** Any changes to position tracking must utilize the atomic write-rename pattern in `PositionStore.ts` to prevent `.json` corruption during power losses.
3. **Never Hardcode Keys:** Ensure all new infrastructure URLs or APIs are routed through the `Config` interface in `index.ts`.

Before submitting a PR, ensure you have tested the logic against a testnet environment or via verification scripts (where applicable).
