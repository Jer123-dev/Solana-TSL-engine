import { TelegramController } from "../core/TelegramController";
import { SolanaSwapEngine } from "../core/SolanaSwapEngine";
import { PositionStore } from "./PositionStore";
import { DEXPriceMonitor } from "../core/DEXPriceMonitor";
import { tradeLatency, tradeSuccess, tradeFailure } from "../utils/Metrics";
import logger from "../utils/Logger";
import { PublicKey } from "@solana/web3.js";
import axios from "axios";
import cfg from "../config";

export class BuyManager {
  // 🛡️ INSTITUTIONAL FIX: Atomic Pending Buys Lock
  private pendingBuys = new Set<string>();

  constructor(
    private telegram: TelegramController, // NEW: Replaced FileWatcher
    private swap: SolanaSwapEngine,
    private priceMon: DEXPriceMonitor,
    private store: PositionStore
  ) {
    // Listens directly to the Telegram chat for pasted contract addresses
    this.telegram.on("newToken", this.onNewToken.bind(this));
    logger.info("🎯 WSS BuyManager initialized with Telegram Telemetry");
  }

  private async onNewToken(mint: string) {
    logger.info(`🆕 Processing Target: ${mint}`);

    // 🛡️ INSTITUTIONAL FIX: Check both active AND pending buys atomically
    if (this.store.positions.has(mint) || this.pendingBuys.has(mint)) {
      this.telegram.sendAlert(`⚠️ <b>Already Active/Pending:</b> You currently hold or are buying <code>${mint}</code>. Ignoring duplicate.`);
      return;
    }

    if (this.store.positions.size + this.pendingBuys.size >= cfg.maxPositions) {
      this.telegram.sendAlert(`🚫 <b>Capacity Reached:</b> Max positions (${cfg.maxPositions}) active or pending. Cannot execute.`);
      return;
    }

    if (!this.isValidSolanaMint(mint)) {
      this.telegram.sendAlert(`❌ <b>Invalid Contract:</b> <code>${mint}</code> is not a valid Solana Base58 address.`);
      return;
    }

    // 🛡️ INSTITUTIONAL FIX: Lock the slot synchronously BEFORE yielding the event loop to the RPC
    this.pendingBuys.add(mint);

    try {
      // 🛡️ INSTITUTIONAL FIX: Parallelized RPC and Oracle Requests
      // Instead of waiting for the balance, THEN waiting for the price, we fire both simultaneously.
      // This shaves off 100ms+ of critical pre-trade latency.
      const [solBalance, entryPrice] = await Promise.all([
        this.swap.getSolBalance(),
        this.fetchInstantPrice(mint)
      ]);

      const requiredAmount = cfg.amount + 0.02; // Buffer for network/priority fees

      if (solBalance < requiredAmount) {
        this.telegram.sendAlert(`💳 <b>Insufficient SOL:</b> Have ${solBalance.toFixed(4)}, Need ${requiredAmount.toFixed(4)}.`);
        return;
      }

      // ⚡ EXECUTE WSS BUY ⚡
      const buyResult = await this.swap.buy(mint);

      if (buyResult.success && buyResult.txid) {
        if (buyResult.latency) tradeLatency.observe(buyResult.latency);
        tradeSuccess.inc();

        const finalEntryPrice = (entryPrice === 0 && buyResult.price) ? buyResult.price : entryPrice;

        // 🛡️ INSTITUTIONAL FIX: Zero-Latency TSL Arming
        // We do not wait for RPC indexing. We arm the TSL and save the position 
        // immediately using the expected amount from the Jupiter quote.
        await this.store.add({
          mint,
          // 🛡️ FATAL FIX: Use the calculated amount from the swap engine
          amount: buyResult.expectedAmount && buyResult.expectedAmount > 0
            ? buyResult.expectedAmount
            : 0,
          entryPrice: finalEntryPrice
        });

        this.priceMon.trackToken(mint, finalEntryPrice);

        // Handle balance refinement in the background
        this.processBuySuccess(mint, buyResult.txid, finalEntryPrice);

      } else {
        tradeFailure.inc();
        logger.error(`❌ Buy failed for ${mint}: ${buyResult.error}`);
        this.telegram.sendAlert(`❌ <b>Execution Failed</b>\nToken: <code>${mint}</code>\nReason: ${buyResult.error}`);

        // 🛡️ MEDIUM FIX: Clear from Telegram memory so you can retry the snipe
        this.telegram.clearProcessedToken(mint);
      }
    } catch (error: any) {
      logger.error(`❌ Critical BuyManager Error: ${error.message}`);
    } finally {
      // 🛡️ INSTITUTIONAL FIX: Always release the pending lock when the sequence finishes
      this.pendingBuys.delete(mint);
    }
  }

  /**
   * 🛡️ INSTITUTIONAL FIX: Background Balance Refinement
   * This method runs in the background to correct the 'amount' in the PositionStore.
   * The TSL is already armed in onNewToken; this just ensures we sell the right quantity.
   */
  private async processBuySuccess(mint: string, txid: string, initialPrice: number) {
    try {
      let tokenBalance: any = null;
      let attempts = 0;
      const maxAttempts = 5;

      // 1. RPC Indexing Backoff Loop
      while (attempts < maxAttempts) {
        // Exponential backoff to avoid RPC rate limits
        const delay = 800 * Math.pow(1.5, attempts);
        await new Promise(resolve => setTimeout(resolve, delay));

        tokenBalance = await this.swap.getTokenBalance(mint);

        if (tokenBalance && tokenBalance.uiAmount > 0) {
          // 🛡️ REFINEMENT: Update the existing PositionStore record with the real balance
          const pos = this.store.positions.get(mint);
          if (pos) {
            pos.amount = tokenBalance.uiAmount;
            await this.store.add(pos); // Atomic Write-Rename update
            logger.info(`✅ Balance indexed for ${mint}: ${pos.amount} tokens.`);
          }
          break;
        }

        attempts++;
        logger.warn(`⚠️ RPC Indexing lag for ${mint} (Attempt ${attempts}/${maxAttempts})...`);
      }

      // 2. Determine final display amount (Fallback to "Quote Estimate" if RPC fails)
      const finalAmountString = tokenBalance?.uiAmountString || "Quote Estimate (RPC Lag)";

      // 3. Dispatch Telegram Receipt
      const successMsg = `
🟢 <b>SNIPE SUCCESSFUL</b>
Token: <code>${mint}</code>
Actual Received: <b>${finalAmountString}</b>
Entry Price: <b>$${initialPrice.toFixed(6)}</b>
<a href="https://solscan.io/tx/${txid}">View on Solscan</a>
      `;

      await this.telegram.sendAlert(successMsg.trim());

      // 🛡️ INSTITUTIONAL FIX: Immediate TSL Arming & Recovery
      // Even if price is 0, we track it so the recovery loop can wake up the SellManager.
      this.priceMon.trackToken(mint, initialPrice);

      if (initialPrice <= 0) {
        logger.warn(`⚠️ Zero-Price Detected for ${mint}. TSL is STANDBY. Launching High-Frequency Recovery...`);
        this.startHighFrequencyRecovery(mint);
      } else {
        logger.info(`✅ TSL ARMED for ${mint} at $${initialPrice.toFixed(8)}`);
      }

    } catch (error: any) {
      logger.error(`❌ Error refining balance for ${mint}: ${error.message}`);
    }
  }

  /**
   * 🛡️ INSTITUTIONAL FIX: High-Frequency Price Recovery
   * Pings the oracle every 2 seconds for a fresh launch. 
   * As soon as a price exists, it "Arms" the position in the Store and Monitor.
   */
  private startHighFrequencyRecovery(mint: string) {
    let attempts = 0;
    const maxAttempts = 30; // Try for 60 seconds (2s intervals)

    const recoveryInterval = setInterval(async () => {
      attempts++;
      if (attempts > maxAttempts) {
        logger.error(`❌ Recovery Failed: Token ${mint} stayed at $0 for 60s. TSL UNARMED.`);
        clearInterval(recoveryInterval);
        return;
      }

      const recoveredPrice = await this.fetchInstantPrice(mint);
      if (recoveredPrice > 0) {
        logger.info(`🎯 PRICE RECOVERED: ${mint} is now $${recoveredPrice.toFixed(8)}. ARMING TSL NOW.`);

        // 1. Update the record so SellManager sees a non-zero entryPrice
        const pos = this.store.positions.get(mint);
        if (pos) {
          pos.entryPrice = recoveredPrice;
          await this.store.add(pos);
        }

        // 2. Re-sync the Trailing Stop-Loss tracker so SellManager can see it
        this.priceMon.trackToken(mint, recoveredPrice);

        clearInterval(recoveryInterval);
      }
    }, 2000);
  }

  /**
   * Unified Instant Pricing: Jupiter V2 -> DexScreener Fallback
   */
  private async fetchInstantPrice(mint: string): Promise<number> {
    try {
      // Primary: Jupiter V2 (Instant On-Chain Oracle)
      const jupResponse = await axios.get(`https://api.jup.ag/price/v2?ids=${mint}`, { timeout: 2000 });
      if (jupResponse.data?.data?.[mint]) {
        return parseFloat(jupResponse.data.data[mint].price);
      }
    } catch (e) {
      // Fallback: DexScreener (Slightly cached, but good for brand-new launches)
      try {
        const dexResponse = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 3000 });
        if (dexResponse.data?.pairs?.length > 0) {
          return parseFloat(dexResponse.data.pairs[0].priceUsd);
        }
      } catch (fallbackErr) { }
    }
    return 0; // Return 0 if completely untrackable, position store will still save it
  }

  private isValidSolanaMint(mint: string): boolean {
    try {
      if (mint.length < 32 || mint.length > 44) return false;
      new PublicKey(mint); // Will throw if invalid Base58
      return true;
    } catch {
      return false;
    }
  }

  // Exposed for health checks/external systemd monitoring
  async healthCheck(): Promise<boolean> {
    try {
      const solBalance = await this.swap.getSolBalance();
      return solBalance > cfg.amount && this.store.positions.size < cfg.maxPositions;
    } catch (error) {
      return false;
    }
  }
}