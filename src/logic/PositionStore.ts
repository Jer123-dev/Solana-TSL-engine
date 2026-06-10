import fs from "fs/promises";
import logger from "../utils/Logger";

interface Position {
  mint: string;
  amount: number;
  entryPrice: number;
  // 🛡️ HIGH FIX: Persist the peak price to disk to survive reboots
  highWatermark?: number;
}

export class PositionStore {
  private file = "positions.json";
  public positions = new Map<string, Position>();

  // 🛡️ INSTITUTIONAL FIX: Write Serialization Queue
  private writeQueue: Promise<void> = Promise.resolve();

  async load() {
    try {
      const data = await fs.readFile(this.file, "utf8");
      const loadedPositions = JSON.parse(data) as Record<string, Position>;
      Object.values(loadedPositions).forEach((p) => {
        this.positions.set(p.mint, p);
      });
      logger.info(`Loaded ${this.positions.size} positions from storage`);
    } catch {
      logger.info("No existing positions file found, starting fresh");
    }
  }

  /**
   * 🛡️ INSTITUTIONAL FIX: Atomic Write-Rename Pattern
   * Guarantees that even if the server loses power mid-write, your position data
   * is NEVER corrupted. Essential for protecting a small bankroll's tracking state.
   */
  async save() {
    const obj = Object.fromEntries(this.positions);
    const jsonData = JSON.stringify(obj, null, 2);
    const tempFile = `${this.file}.tmp`;

    // 1. Queue the write to ensure no overlapping disk activity
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        // 2. Write to a temporary file first
        await fs.writeFile(tempFile, jsonData);

        // 3. Perform the atomic rename (The OS swap)
        // If the write above failed, the rename never happens, preserving the old data.
        await fs.rename(tempFile, this.file);

        logger.debug(`💾 Atomic save successful for ${this.positions.size} positions`);
      } catch (err) {
        logger.error(`❌ CRITICAL: Atomic file save failed: ${err}`);
        // Attempt to clean up the orphaned temp file if it exists
        try { await fs.unlink(tempFile); } catch { }
      }
    });

    await this.writeQueue;
  }

  async add(p: Position) {
    this.positions.set(p.mint, p);
    logger.info(`Added position for ${p.mint}: ${p.amount} tokens at $${p.entryPrice.toFixed(8)}`);
    return this.save();
  }

  async remove(mint: string) {
    const removed = this.positions.delete(mint);
    if (removed) {
      logger.info(`Removed position for ${mint}`);
      await this.save();
    }
    return removed;
  }

  // New method: Clear all positions
  async clearAll() {
    const count = this.positions.size;
    this.positions.clear();
    await this.save();
    logger.info(`Cleared all ${count} positions from storage`);
  }

  // New method: Validate positions against actual wallet balances
  async validatePositions(getTokenBalance: (mint: string) => Promise<any>) {
    const invalidPositions: string[] = [];

    logger.info(`Validating ${this.positions.size} positions against wallet...`);

    for (const [mint, position] of this.positions) {
      try {
        const balance = await getTokenBalance(mint);

        // If no balance or zero balance, mark as invalid
        if (!balance || balance.uiAmount === 0) {
          invalidPositions.push(mint);
          logger.warn(`Position for ${mint} has no wallet balance - marking for removal`);
        } else {
          logger.debug(`Position for ${mint} validated: ${balance.uiAmount} tokens in wallet`);
        }
      } catch (error) {
        // 🛡️ HIGH FIX: Do NOT delete the position if the RPC fails.
        // A network hiccup shouldn't wipe your active trades.
        // We just remove the .message so it prints the raw error safely
        logger.warn(`⚠️ RPC error validating ${mint}. Skipping check to preserve position: ${error}`);
        // We do NOT push to invalidPositions here, so it remains on disk.
      }
    }

    // Remove invalid positions
    for (const mint of invalidPositions) {
      await this.remove(mint);
    }

    if (invalidPositions.length > 0) {
      logger.info(`Removed ${invalidPositions.length} stale positions: ${invalidPositions.join(', ')}`);
    } else {
      logger.info("All positions validated successfully");
    }

    return {
      removed: invalidPositions.length,
      remaining: this.positions.size
    };
  }

  // Get position info for debugging
  getPositionInfo() {
    const positions = Array.from(this.positions.entries()).map(([mint, pos]) => ({
      mint: mint.substring(0, 8) + '...',
      amount: pos.amount,
      entryPrice: pos.entryPrice
    }));

    return {
      count: this.positions.size,
      positions: positions
    };
  }

  // Check if a position exists
  hasPosition(mint: string): boolean {
    return this.positions.has(mint);
  }

  // Get all position mints
  getAllMints(): string[] {
    return Array.from(this.positions.keys());
  }
}