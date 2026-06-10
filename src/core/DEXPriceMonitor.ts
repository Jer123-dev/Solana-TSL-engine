import { Connection, PublicKey } from "@solana/web3.js";
import axios from "axios";
import logger from "../utils/Logger";

type PriceCallback = (mint: string, price: number) => void;

interface TokenPriceData {
  mint: string;
  price: number;
  lastUpdated: number;
  subId?: number; // The Helius WebSocket Subscription ID
}

export class DEXPriceMonitor {
  private connection: Connection;
  // 🛡️ FATAL FIX: Store URLs so we can create fresh connections
  private rpcUrl: string;
  private wssUrl: string;
  private callbacks: PriceCallback[] = [];
  private priceCache = new Map<string, TokenPriceData>();
  private onRebootCallback?: (conn: Connection) => void;

  public setOnReboot(cb: (conn: Connection) => void) {
    this.onRebootCallback = cb;
  }

  // 🛡️ SMART VALVE VARIABLES: Protects 1-RPS without losing instant execution
  private pendingMints = new Set<string>();
  private lastFetchTime: number = 0;
  private isValveWaiting: boolean = false;

  // 🛡️ Heartbeat Watchdog variables
  private lastActivity: number = Date.now();
  private slotSubId?: number;
  private watchdogTimer?: NodeJS.Timeout;

  constructor(connection: Connection, rpcUrl: string, wssUrl: string) {
    this.connection = connection;
    this.rpcUrl = rpcUrl;
    this.wssUrl = wssUrl;
    logger.info("📡 Helius WSS Event-Driven Price Monitor initialized");
  }

  subscribe(cb: PriceCallback) {
    this.callbacks.push(cb);
    logger.info(`Price monitor callback registered. Total callbacks: ${this.callbacks.length}`);
  }

  /**
   * Starts the monitor. Now accepts existing positions from PositionStore
   * to immediately re-subscribe to WebSockets upon bot restart.
   */
  start(existingPositions?: Map<string, any>) {
    logger.info("🚀 Starting Event-Driven WSS Price Monitoring...");

    this.startWatchdog(); // 🛡️ Boot the Heartbeat Monitor

    if (existingPositions && existingPositions.size > 0) {
      existingPositions.forEach((_, mint) => {
        this.trackToken(mint);
      });
    }
  }

  stop() {
    this.priceCache.forEach((data, mint) => {
      this.untrackToken(mint);
    });

    // Clean up watchdog
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.slotSubId !== undefined) {
      this.connection.removeSlotChangeListener(this.slotSubId).catch(() => { });
    }

    logger.info("🛑 WSS Price Monitoring stopped");
  }

  /**
   * 🛡️ INSTITUTIONAL FIX: The WSS Heartbeat
   * Listens to the Solana slot clock. If no blocks are produced in 30s, the socket is dead.
   */
  private startWatchdog() {
    if (this.slotSubId !== undefined) return;

    // Solana produces a slot every ~400ms. This is our pulse.
    this.slotSubId = this.connection.onSlotChange(() => {
      this.lastActivity = Date.now();
    });

    // Check the pulse every 2 seconds
    this.watchdogTimer = setInterval(() => {
      const timeSincePulse = Date.now() - this.lastActivity;

      // 🛡️ INSTITUTIONAL FIX: 5-second "Aggressive" Heartbeat
      // If 5 seconds pass without a slot change, we assume the WSS is hung.
      if (timeSincePulse > 5000) {
        logger.error(`🚨 WSS Heartbeat Flatlined (${timeSincePulse}ms). Rebooting listeners...`);
        this.rebootConnection();
      }
    }, 2000);
  }

  /**
   * 🛡️ INSTITUTIONAL FIX: Safely tears down all dead listeners AND the dead slot heartbeat,
   * then re-establishes them to break the watchdog death spiral.
   */
  private async rebootConnection() {
    this.lastActivity = Date.now();

    // 🛡️ FATAL FIX: Create a brand new Connection object to clear the dead socket.
    // Reusing the old connection object (Flaw #3) is why the watchdog fails to recover.
    try {
      logger.info("🔄 Creating fresh Solana Connection for WSS Recovery...");
      this.connection = new Connection(this.rpcUrl, {
        wsEndpoint: this.wssUrl,
        commitment: "confirmed"
      });

      // 🚨 ADD THIS LINE RIGHT HERE 🚨
      // Broadcast the new connection to the SwapEngine instantly
      if (this.onRebootCallback) this.onRebootCallback(this.connection);

    } catch (e) {
      logger.error(`❌ Failed to re-instantiate Connection object: ${e}`);
    }

    // 1. Tear down the dead Heartbeat (Slot) Listener
    if (this.slotSubId !== undefined) {
      try { await this.connection.removeSlotChangeListener(this.slotSubId); } catch (e) { }
      this.slotSubId = undefined;
    }

    // 2. Re-attach the Heartbeat Listener to the NEW connection
    this.slotSubId = this.connection.onSlotChange(() => {
      this.lastActivity = Date.now();
    });

    // 3. Tear down dead token WSS listeners
    for (const [mint, data] of this.priceCache.entries()) {
      if (data.subId !== undefined) {
        try { await this.connection.removeOnLogsListener(data.subId); } catch (e) { }
        data.subId = undefined;
      }
    }

    // 4. Re-establish token tracking on the NEW connection
    logger.info(`🔄 Re-establishing WSS listeners for ${this.priceCache.size} targets on fresh socket...`);
    const activeMints = Array.from(this.priceCache.keys());
    for (const mint of activeMints) {
      this.trackToken(mint, this.priceCache.get(mint)?.price);
    }
  }

  /**
   * Subscribes directly to the blockchain for instant trade notifications.
   */
  trackToken(mint: string, initialPrice = 0) {
    // 🛡️ Modified guard: only abort if it has an ACTIVE subscription. 
    // This allows rebootConnection() to successfully re-track tokens after a dead socket.
    if (this.priceCache.has(mint) && this.priceCache.get(mint)?.subId !== undefined) {
      logger.debug(`Token ${mint} is already being tracked via WSS`);
      return;
    }

    try {
      const pubkey = new PublicKey(mint);

      // THE MAGIC: Listen to on-chain logs for this specific token.
      // Fires instantly the moment ANY trade touches this token's liquidity pool.
      const subId = this.connection.onLogs(
        pubkey,
        (logs) => {
          if (logs.err) return; // Ignore failed transactions

          // 🛡️ INSTITUTIONAL FIX: Catching the Floating Promise
          // Explicitly chaining .catch() prevents Node.js from fatally crashing 
          // if an unexpected error escapes the async price fetch.
          this.handleTokenEvent(mint).catch(err => {
            logger.debug(`Silent WSS execution caught for ${mint}: ${err.message}`);
          });
        },
        // 🛡️ MEDIUM FIX: Use 'confirmed' to avoid phantom signals and false TSL triggers.
        "confirmed"
      );

      this.priceCache.set(mint, {
        mint,
        price: initialPrice,
        lastUpdated: Date.now(),
        subId
      });

      logger.info(`🔗 WSS Locked on target: ${mint}`);

      // Fetch the initial price immediately upon tracking
      this.handleTokenEvent(mint).catch(err => {
        logger.debug(`Initial price fetch caught for ${mint}: ${err.message}`);
      });

    } catch (error: any) {
      logger.error(`❌ Failed to establish WSS track for ${mint}: ${error.message}`);
    }
  }

  /**
   * Cleanly closes the WebSocket subscription when the position is sold.
   */
  untrackToken(mint: string) {
    const data = this.priceCache.get(mint);
    if (data && data.subId !== undefined) {
      this.connection.removeOnLogsListener(data.subId).catch(e =>
        logger.warn(`Failed to cleanly remove WS listener for ${mint}: ${e}`)
      );
    }

    this.priceCache.delete(mint);
    this.pendingMints.delete(mint); // Remove from the basket
    logger.info(`✂️ Cut WSS connection for token: ${mint}`);
  }

  /**
   * 🛡️ INSTITUTIONAL FIX: Zero-Latency Execution
   * Triggered by the WebSocket. Fetches the exact post-trade price instantly.
   * Artificial lag removed to guarantee the 20% TSL fires on the exact microsecond.
   */
  /**
   * 🛡️ THE SMART VALVE TRIGGER
   * Fired instantly by the WSS onLogs doorbell.
   */
  private async handleTokenEvent(mint: string) {
    // 1. Drop the token into the basket
    this.pendingMints.add(mint);

    // 2. Try to open the valve
    this.checkSmartValve();
  }

  /**
   * Evaluates the timestamp to decide if we fetch instantly or wait for cooldown.
   */
  private checkSmartValve() {
    if (this.isValveWaiting) return; // A timer is already handling the cooldown basket

    const now = Date.now();
    const timeSinceLastFetch = now - this.lastFetchTime;

    if (timeSinceLastFetch >= cfg.pollingIntervalMs) {
      // 🟢 Valve is OPEN. More than 1.1s has passed. Fetch instantly.
      this.flushPendingMints();
    } else {
      // 🔴 Valve is LOCKED. Calculate remaining cooldown time.
      const delayNeeded = cfg.pollingIntervalMs - timeSinceLastFetch;
      this.isValveWaiting = true;

      setTimeout(() => {
        this.isValveWaiting = false;
        this.flushPendingMints();
      }, delayNeeded);
    }
  }

  /**
   * 🛡️ WATERFALL SMART VALVE (V3 SCHEMA FIX + DEXSCREENER FALLBACK)
   * Empties the basket and fetches the batched prices.
   */
  private async flushPendingMints() {
    if (this.pendingMints.size === 0) return;

    // Snapshot the basket and clear it instantly
    const mintsToFetch = Array.from(this.pendingMints);
    this.pendingMints.clear();

    // Lock the valve timestamp NOW
    this.lastFetchTime = Date.now();

    try {
      const queryIds = mintsToFetch.join(",");
      let finalPrices = new Map<string, number>();

      // 1. 🏦 PRIMARY: Ask Jupiter V3 
      try {
        const jupResponse = await axios.get(`https://api.jup.ag/price/v3?ids=${queryIds}`, {
          timeout: 1000,
          headers: {
            'x-api-key': cfg.jupiterPriceApiKey
          }
        });

        // 🛡️ FACTUAL V3 SCHEMA PARSER: Handles both wrapper variations and 'usdPrice'
        const responsePayload = jupResponse.data?.data || jupResponse.data;

        if (responsePayload) {
          for (const mint of mintsToFetch) {
            const tokenData = responsePayload[mint];
            // Look for V3 'usdPrice' first, fallback to 'price' just in case
            const priceVal = tokenData?.usdPrice ?? tokenData?.price;

            if (priceVal !== undefined && priceVal !== null) {
              finalPrices.set(mint, Number(priceVal));
            }
          }
        }
      } catch (e: any) {
        // 🛡️ DIAGNOSTIC FIX: Upgraded from debug to warn so it prints live to your terminal screen
        logger.warn(`⚠️ Jupiter V3 pricing failed or token delisted. Routing fallback to DexScreener. Err: ${e.message}`);
      }

      // 2. 🛡️ DEAD POOL FALLBACK: Ask DexScreener for any tokens Jupiter ignored
      const missingMints = mintsToFetch.filter(mint => !finalPrices.has(mint));

      if (missingMints.length > 0) {
        const dexQuery = missingMints.join(",");
        try {
          const dexResponse = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${dexQuery}`, { timeout: 1500 });
          if (dexResponse.data && dexResponse.data.pairs) {
            for (const mint of missingMints) {
              // Get the highest liquidity pair for this specific token to avoid fake LPs
              const pairs = dexResponse.data.pairs.filter((p: any) => p.baseToken.address === mint);
              if (pairs.length > 0) {
                // Sort by liquidity to ensure we grab the real pool
                pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
                finalPrices.set(mint, parseFloat(pairs[0].priceUsd));
              }
            }
          }
        } catch (e: any) {
          logger.error(`❌ Dead Pool Fallback Failed: DexScreener API timed out or rejected request: ${e.message}`);
        }
      }

      // 3. Update local cache and fire TSL evaluations
      for (const mint of mintsToFetch) {
        const newPrice = finalPrices.get(mint);

        if (newPrice && newPrice > 0) {
          const cached = this.priceCache.get(mint);
          if (cached) {
            cached.price = newPrice;
            cached.lastUpdated = Date.now();

            // Fire to SellManager for immediate peak/drop math
            this.callbacks.forEach(cb => cb(mint, newPrice));
          }
        } else {
          // 🚨 Both APIs completely failed. Put it back in the basket so we don't lose the tracker.
          this.pendingMints.add(mint);
        }
      }
    } catch (error: any) {
      logger.debug(`Smart Valve fetch failed completely, requeueing. Err: ${error.message}`);
      mintsToFetch.forEach(m => this.pendingMints.add(m));
    }
  }

  // --- Utility Methods Maintained for Compatibility ---

  getCurrentPrice(mint: string): number | null {
    return this.priceCache.get(mint)?.price || null;
  }

  getTrackedTokens(): Map<string, TokenPriceData> {
    return new Map(this.priceCache);
  }

  getStats() {
    return {
      trackedTokens: this.priceCache.size,
      callbacks: this.callbacks.length,
      isActive: this.priceCache.size > 0, // Now based on active WS connections, not a global interval
      strategy: "Helius WSS Event-Driven + Jupiter V2 Oracle"
    };
  }

  async forceUpdate(mint: string): Promise<boolean> {
    if (!this.priceCache.has(mint)) {
      logger.warn(`Cannot force update - ${mint} is not being tracked`);
      return false;
    }

    // Push it through the Smart Valve manually
    await this.handleTokenEvent(mint);
    return true;
  }