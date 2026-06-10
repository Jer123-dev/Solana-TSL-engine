import { TelegramController } from "../core/TelegramController";
import { DEXPriceMonitor } from "../core/DEXPriceMonitor";
import { SolanaSwapEngine } from "../core/SolanaSwapEngine";
import { PositionStore } from "./PositionStore";
import logger from "../utils/Logger";
import cfg from "../config";

export class SellManager {
  private sellLocks = new Set<string>(); // High-frequency WSS lock
  private trailingStops = new Map<string, number>(); // Track high-watermarks for TSL

  constructor(
    private telegram: TelegramController, // NEW: Telegram UI Injection
    private priceMon: DEXPriceMonitor,
    private swap: SolanaSwapEngine,
    private store: PositionStore
  ) {
    // Listen directly to the ultra-fast WSS price feed
    priceMon.subscribe(this.onPrice.bind(this));
    logger.info("🛡️ WSS SellManager (TSL Engine) initialized with Telegram Telemetry");
  }

  /**
   * Evaluates the Trailing Stop-Loss on every single tick from the WebSocket.
   */
  private async onPrice(mint: string, price: number) {
    const pos = this.store.positions.get(mint);
    // 🛡️ INSTITUTIONAL FIX: TSL now fires even on fresh launches 
    // because we have an instant fallback price from the swap engine.
    if (!pos || pos.entryPrice <= 0) return;

    // CRITICAL LOCK: WSS can fire extremely fast during a dump.
    // If we are already selling, ignore all further price ticks for this token.
    if (this.sellLocks.has(mint)) return;

    try {
      // 1. Update trailing high (The Watermark)
      // 🛡️ HIGH FIX: Pull from disk (pos.highWatermark) if memory is empty (after restart)
      const currentHigh = this.trailingStops.get(mint) || pos.highWatermark || pos.entryPrice;
      const newHigh = Math.max(currentHigh, price);

      if (newHigh > currentHigh) {
        this.trailingStops.set(mint, newHigh);

        // 🛡️ HIGH FIX: Save the new peak to disk immediately
        pos.highWatermark = newHigh;
        this.store.save().catch(e => logger.error(`Failed to persist watermark: ${e}`));
      }

      // 2. Calculate the exact percentage drop
      const dropPct = ((newHigh - price) / newHigh) * 100;

      // 3. Evaluate Trailing Stop-Loss Threshold
      if (dropPct >= cfg.trailingStop) {
        logger.info(`🚨 TSL TRIGGERED for ${mint}: ${dropPct.toFixed(2)}% drop from $${newHigh.toFixed(8)}`);

        // INSTANTLY lock to prevent duplicate RPC calls
        this.sellLocks.add(mint);

        // 🛡️ INSTITUTIONAL FIX: Removed Dangerous Pre-Sell Validation
        // We no longer ask the RPC for our balance during a volatile dump. 
        // If the RPC is lagging and returns '0', the old code would abandon your funds.
        // Now, we blindly fire the sell command. The blockchain is the ultimate source of truth.

        // ⚡ EXECUTE WSS SELL ⚡
        // 🛡️ INSTITUTIONAL FIX: Pass the exact recorded amount. Do not rely on "auto".
        const result = await this.swap.sell(mint, pos.amount);

        if (result.success && result.txid) {
          // Calculate final PnL based on actual sell trigger vs entry
          const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
          const pnlEmoji = pnlPct >= 0 ? "🟢" : "🔴";
          const pnlText = pnlPct >= 0 ? "Profit" : "Loss";

          // Dispatch Telegram Receipt
          const receiptMsg = `
${pnlEmoji} <b>POSITION CLOSED (TSL)</b>
Token: <code>${mint}</code>
Sell Price: <b>$${price.toFixed(6)}</b>
${pnlText}: <b>${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%</b>
<a href="https://solscan.io/tx/${result.txid}">View on Solscan</a>
          `;
          await this.telegram.sendAlert(receiptMsg.trim());

          // Completely wipe the token from tracking and memory
          await this.cleanupPosition(mint);
        } else {
          logger.error(`❌ Sell execution failed for ${mint}: ${result.error}`);
          // Remove the lock so it tries again on the next WSS price tick
          this.sellLocks.delete(mint);
        }
      }
    } catch (error) {
      logger.error(`Error in TSL logic for ${mint}: ${error}`);
      this.sellLocks.delete(mint); // Ensure lock is cleared on hard crashes
    }
  }

  /**
   * Safely completely tears down tracking for a sold token.
   */
  private async cleanupPosition(mint: string) {
    try {
      await this.store.remove(mint); // Remove from local JSON
      logger.info(`🧹 Position removed from disk for ${mint}`);
    } catch (error) {
      // If the disk write fails, we log it, but we DO NOT stop the cleanup process.
      logger.error(`Error cleaning up position disk state for ${mint}: ${error}`);
    } finally {
      // 🛡️ INSTITUTIONAL FIX: The 'finally' block executes no matter what.
      this.trailingStops.delete(mint); // Wipe TSL memory
      this.priceMon.untrackToken(mint); // ✂️ Cut the Helius WebSocket connection
      this.sellLocks.delete(mint); // Release the sell lock

      // 🛡️ INSTITUTIONAL FIX: Tell Telegram to forget the token so we can re-snipe it later
      if (typeof (this.telegram as any).clearProcessedToken === 'function') {
        (this.telegram as any).clearProcessedToken(mint);
      }

      logger.info(`🧹 Memory & WSS Listeners completely cleaned up for ${mint}`);
    }
  }

  /**
   * Manual override trigger, upgraded with Telegram alerts.
   */
  async forceSell(mint: string): Promise<boolean> {
    if (this.sellLocks.has(mint)) return false;

    const pos = this.store.positions.get(mint);
    if (!pos) return false;

    this.sellLocks.add(mint);

    try {
      // 🛡️ INSTITUTIONAL FIX: Removed dangerous pre-sell validation here as well.
      // We proceed straight to execution.

      this.telegram.sendAlert(`⚡ <b>Manual Override:</b> Force selling <code>${mint}</code>...`);
      // 🛡️ INSTITUTIONAL FIX: Pass exact amount for manual force sells as well
      const result = await this.swap.sell(mint, pos.amount);

      if (result.success && result.txid) {
        // Fetch current price for PnL estimation
        const currentPrice = this.priceMon.getCurrentPrice(mint) || pos.entryPrice;
        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

        const receiptMsg = `
☢️ <b>FORCE SELL EXECUTED</b>
Token: <code>${mint}</code>
Est. PnL: <b>${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%</b>
<a href="https://solscan.io/tx/${result.txid}">View on Solscan</a>
        `;
        await this.telegram.sendAlert(receiptMsg.trim());

        await this.cleanupPosition(mint);
        return true;
      } else {
        this.telegram.sendAlert(`❌ <b>Force Sell Failed:</b> ${result.error}`);
        return false;
      }
    } catch (error) {
      logger.error(`Error in force sell for ${mint}: ${error}`);
      return false;
    } finally {
      this.sellLocks.delete(mint);
    }
  }

  getTrailingStopInfo(): Map<string, number> {
    return new Map(this.trailingStops);
  }

  getActiveSellOperations(): string[] {
    return Array.from(this.sellLocks);
  }
}