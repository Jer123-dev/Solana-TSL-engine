import { Connection } from "@solana/web3.js";
import cfg from "./config";
import { TelegramController } from "./core/TelegramController";
import { DEXPriceMonitor } from "./core/DEXPriceMonitor";
import { SolanaSwapEngine } from "./core/SolanaSwapEngine";
import { PositionStore } from "./logic/PositionStore";
import { BuyManager } from "./logic/BuyManager";
import { SellManager } from "./logic/SellManager";
import { handleError } from "./utils/ErrorHandler";
import { startMetricsServer } from "./utils/Metrics";
import logger from "./utils/Logger";

// 🛡️ INSTITUTIONAL FIX: Global Scope Declaration
// By declaring these here, our Graceful Shutdown sequence can access 
// them to save state and cut WSS connections if a fatal crash occurs.
let telegram: TelegramController;
let priceMon: DEXPriceMonitor;
let swap: SolanaSwapEngine;
let store: PositionStore;
let isShuttingDown = false;

/**
 * 🛡️ INSTITUTIONAL FIX: Graceful Shutdown Sequence (Flaw #9)
 * Safely tears down the network and commits memory to disk before dying.
 */
const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`\n🛑 Received ${signal}. Initiating Graceful Shutdown Protocol...`);

  try {
    if (priceMon) priceMon.stop();

    // Attempt to clear the SolanaSwapEngine fee polling interval if we've added the method
    if (swap && typeof (swap as any).destroy === 'function') {
      (swap as any).destroy();
    }

    if (store) {
      logger.info("💾 Committing final position state to disk...");
      await store.save();
    }

    logger.info("✅ Shutdown complete. Process exiting cleanly.");
    process.exit(0);
  } catch (err) {
    logger.error(`❌ Critical error during shutdown: ${err}`);
    process.exit(1);
  }
};

// Bind shutdown sequence to terminal kill commands (Ctrl+C, systemctl stop)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

/**
 * 🛡️ INSTITUTIONAL FIX: Global Crash Handlers (Flaw #4)
 * Prevents "Floating Promises" from silently instantly killing the bot.
 */
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`🚨 FATAL RUNTIME ERROR: Unhandled Promise Rejection.\nReason: ${reason}`);
  // We log the error, but we do NOT instantly kill the bot, allowing WSS to keep running.
  if (telegram) telegram.sendAlert(`🚨 <b>SYSTEM ERROR:</b> Unhandled Rejection: ${reason}`).catch(() => { });
});

process.on('uncaughtException', (err) => {
  logger.error(`🚨 FATAL RUNTIME ERROR: Uncaught Exception.\nMessage: ${err.message}\nStack: ${err.stack}`);
  if (telegram) telegram.sendAlert(`🚨 <b>SYSTEM CRASH:</b> Uncaught Exception: ${err.message}`).catch(() => { });
  // Uncaught Exceptions leave Node in a broken state. We MUST shut down, but we do it gracefully.
  gracefulShutdown('uncaughtException');
});

async function main() {
  try {
    startMetricsServer();

    logger.info("🔌 Establishing global Helius WebSocket connection...");
    const connection = new Connection(cfg.rpcUrl, {
      wsEndpoint: cfg.wssUrl, // Safely using the corrected variable
      commitment: "confirmed",
    });

    logger.info("🤖 Starting Telegram UI Controller...");
    telegram = new TelegramController();
    await telegram.start(); // Ensure your TelegramController has a start() method

    // Initialize Global Engines
    // 🛡️ FATAL FIX: Pass the RPC and WSS URLs so the monitor can self-heal
    priceMon = new DEXPriceMonitor(
      connection,
      cfg.rpcUrl,
      cfg.wssUrl
    );
    // 🛡️ HIGH FIX: The "Blind Hands" Sync
    // This connects the eyes (PriceMonitor) to the hands (SwapEngine)
    priceMon.setOnReboot((newConn) => {
      swap.updateConnection(newConn);
    });

    swap = new SolanaSwapEngine(connection);
    store = new PositionStore();

    await store.load();

    logger.info("🔍 Validating positions against actual wallet balances...");
    const validation = await store.validatePositions(async (mint: string) => await swap.getTokenBalance(mint));

    if (validation.removed > 0) {
      logger.info(`✅ Cleaned up ${validation.removed} stale positions. Active: ${validation.remaining}`);
    } else {
      logger.info(`✅ All ${validation.remaining} positions are valid`);
    }

    new BuyManager(telegram, swap, priceMon, store);
    new SellManager(telegram, priceMon, swap, store);

    priceMon.start(store.positions);

    logger.info(`🚀 Sniper Bot live with ${store.positions.size}/${cfg.maxPositions} active positions`);

    const posInfo = store.getPositionInfo();
    if (posInfo.count > 0) {
      logger.info(`📊 Current positions: ${JSON.stringify(posInfo.positions)}`);
    }

  } catch (err) {
    handleError(err, "main");
    process.exit(1);
  }
}

main();