import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  SystemProgram,
  TransactionMessage,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import bs58 from "bs58";
import cfg from "../config";
import logger from "../utils/Logger";
import https from "https";
import axios from "axios"; // 🛡️ Add this at the top with other imports
import { getAssociatedTokenAddress, getAccount, TokenAccountNotFoundError, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

// 🛡️ HELIUS SENDER FIX: Global Anycast Tunnel (Auto-routes to East Coast)
const SENDER_ENDPOINT = cfg.heliusSenderUrl;
const TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or"
];

interface TokenBalance {
  amount: bigint;
  decimals: number;
  uiAmount: number;
  uiAmountString: string;
}

interface SwapResult {
  success: boolean;
  txid?: string;
  error?: string;
  latency?: number;
  price?: number;
  // 🛡️ FATAL FIX: Added field to track purchased quantity
  expectedAmount?: number;
}

export class SolanaSwapEngine {
  private connection: Connection; // Inherited from index.ts
  private keypair: Keypair;
  private _attemptCtx?: number;

  // 🛡️ INSTITUTIONAL FIX: Background Fee Polling Variables
  private baselinePriorityFee: number;
  private feePollingInterval?: NodeJS.Timeout;

  // NEW: Accept the global unified Connection from index.ts
  constructor(connection: Connection) {
    this.keypair = Keypair.fromSecretKey(bs58.decode(cfg.privateKey));
    this.connection = connection;
    this.baselinePriorityFee = cfg.minPriorityFee || 10000; // Default safe start
    logger.info(`🚀 Helius WebSocket SwapEngine initialized for wallet: ${this.keypair.publicKey.toBase58()}`);
  }

  // 🛡️ HIGH FIX: Allows the engine to receive a fresh connection if the WSS dies
  public updateConnection(newConnection: Connection) {
    this.connection = newConnection;
    logger.info("🔄 SwapEngine successfully synced with fresh WSS connection.");
  }

  /**
   * Ultra-fast WebSocket buy execution.
   */
  /**
   * 🛡️ INSTITUTIONAL FIX: Safety-First Buy Execution
   * Performs deep-scan for Freeze Authorities, Permanent Delegates, and Hidden Taxes
   * before committing any capital.
   */
  async buy(tokenMint: string): Promise<SwapResult> {
    const start = Date.now();

    try {
      logger.info(`🚀 Initiating Safety-Scan & Buy: ${cfg.amount} SOL -> ${tokenMint}`);
      this._attemptCtx = 1;

      // 1. ADVANCED PRE-FLIGHT: Mint Security Audit
      const mintPublicKey = new PublicKey(tokenMint);
      const mintInfo = await this.connection.getParsedAccountInfo(mintPublicKey);

      if (!mintInfo.value) throw new Error("Could not verify mint authority. Aborting for safety.");

      const parsedData = (mintInfo.value.data as any).parsed?.info;
      const extensions = (mintInfo.value.data as any).parsed?.extensions || [];

      // A. Check for Freeze Authority (The HoneyPot Trap)
      if (parsedData?.freezeAuthority) {
        throw new Error(`❌ SCAM DETECTED: Mint has an active Freeze Authority (${parsedData.freezeAuthority}). Tokens can be locked at any time.`);
      }

      // B. Check for Permanent Delegate (The Clawback Trap)
      const hasPermanentDelegate = extensions.some((ext: any) => ext.extension === 'permanentDelegate');
      if (hasPermanentDelegate) {
        throw new Error("❌ SCAM DETECTED: Token-2022 Permanent Delegate active. Developer can revoke your tokens.");
      }

      // C. Check for Transfer Fees (Hidden Taxes)
      const transferFeeExt = extensions.find((ext: any) => ext.extension === 'transferFeeConfig');
      if (transferFeeExt) {
        const feeBps = transferFeeExt.state?.newerTransferFee?.transferFeeBasisPoints || 0;
        logger.warn(`⚠️ TAX DETECTED: This token has a ${feeBps / 100}% transfer tax.`);

        if (feeBps / 100 > cfg.slippage) {
          throw new Error(`❌ TAX TOO HIGH: ${feeBps / 100}% tax exceeds your ${cfg.slippage}% slippage limit.`);
        }
      }

      // 🛡️ INSTITUTIONAL FIX: Transfer Hook Detection (The "Hook-Rug" Shield)
      // Scammers use Transfer Hooks to bypass fee checks and steal 99% of value.
      // For a $30 bankroll, we hard-block ANY custom hooks to ensure 100% safety.
      const hasTransferHook = extensions.some((ext: any) => ext.extension === 'transferHook');
      if (hasTransferHook) {
        throw new Error("❌ SCAM DETECTED: Token-2022 Transfer Hook active. This is a potential Honeypot/Blacklist trap.");
      }

      // 2. Capital & Quote Verification
      const preSolBalance = await this.getSolBalance();
      if (preSolBalance < cfg.amount + 0.02) {
        throw new Error(`Insufficient SOL. Have: ${preSolBalance.toFixed(4)}, Need: ${(cfg.amount + 0.02).toFixed(4)}`);
      }

      const quoteResponse = await this.getQuote(
        "So11111111111111111111111111111111111111112",
        tokenMint,
        Math.floor(cfg.amount * 1e9).toString()
      );
      if (!quoteResponse) throw new Error("Failed to get quote from Jupiter");

      // 3. Build Transaction with Dynamic Fees
      const { swapTransaction } = await this.getSwapTransaction(quoteResponse);

      // 4. 🚀 Fire and Confirm via Helius Sender Tunnel
      const tippedTransaction = await this.injectJitoTipAndSign(swapTransaction);
      // Pass the tippedTx for Plan A, and the pure swapTransaction for Plan B
      const txid = await this.broadcastViaSender(tippedTransaction, swapTransaction);
      const latency = (Date.now() - start) / 1000;

      // 🛡️ INSTITUTIONAL FIX: Calculate exact entry price from the quote for instant TSL arming
      const inAmount = Number(quoteResponse.inAmount) / 1e9; // SOL has 9 decimals
      const outAmount = Number(quoteResponse.outAmount) / Math.pow(10, parsedData?.decimals || 9);
      const quotePrice = inAmount / outAmount;

      logger.info(`✅ BUY CONFIRMED (WSS): ${tokenMint} -> ${txid} (${latency.toFixed(2)}s)`);
      // 🛡️ FATAL FIX: Calculate exact outAmount from the Jupiter quote
      const decimals = parsedData?.decimals || 9;
      const expectedAmount = Number(quoteResponse.outAmount) / Math.pow(10, decimals);

      return {
        success: true,
        txid,
        latency,
        price: quotePrice,
        expectedAmount // Now the BuyManager knows exactly what we hold
      };

    } catch (err: any) {
      const latency = (Date.now() - start) / 1000;
      logger.error(`❌ BUY FAILED: ${err.message}`);
      return { success: false, error: err.message || String(err), latency };
    }
  }

  /**
   * Ultra-fast WebSocket sell execution.
   */
  async sell(tokenMint: string, amount: number | "auto" = "auto"): Promise<SwapResult> {
    const start = Date.now();

    try {
      const mintPublicKey = new PublicKey(tokenMint);
      logger.info(`🚀 Initiating Security-Scan & Sell: ${tokenMint} -> SOL`);
      this._attemptCtx = 1;

      // 🛡️ INSTITUTIONAL FIX: Pre-Sell Security Re-Scan
      // Detects if the dev enabled Freeze Authority or Hooks AFTER you bought.
      const accountInfo = await this.connection.getParsedAccountInfo(mintPublicKey);
      const mintData = (accountInfo.value?.data as any)?.parsed?.info;

      if (mintData) {
        // 🛡️ FATAL FIX: Emergency Exit for Freeze Authorities
        // If a dev enables freeze, they are about to rug. We MUST try to outrun them.
        if (mintData.freezeAuthority !== null) {
          logger.warn(`🚨 EMERGENCY: Freeze Authority detected on ${tokenMint}! Dev is preparing a rug. Attempting high-priority exit before the block is finalized...`);
          // We DO NOT throw. We continue to the sell execution.
        }

        // 2. Check for newly enabled Transfer Hooks (Token-2022 specific)
        const extensions = (accountInfo.value?.data as any)?.parsed?.extensions || [];
        const hasHook = extensions.some((e: any) => e.extension === 'transferHook');

        // 🛡️ HIGH FIX: Emergency Exit for Hook-Rugs
        if (hasHook) {
          logger.warn("🚨 EMERGENCY: Transfer Hook detected on sell! Attempting high-priority exit...");
          // We DO NOT throw. We let the blockchain try to force the sell.
        }
      }

      let preTokenBalance = await this.getTokenBalance(tokenMint);

      // 🛡️ INSTITUTIONAL FIX: The "Blind Sell" Execution
      // For highly volatile stealth launches, the RPC indexer often lags behind WSS price ticks.
      // Instead of waiting/looping for the RPC to catch up, we force the sell mathematically.

      let decimals = 9;
      if (preTokenBalance) {
        decimals = preTokenBalance.decimals;
      } else {
        // If RPC completely fails to find the token account, fetch mint decimals directly
        try {
          const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(tokenMint));
          if (mintInfo.value?.data && 'parsed' in mintInfo.value.data) {
            decimals = (mintInfo.value.data as any).parsed.info.decimals;
          }
        } catch (e) { /* ignore and use default 9 */ }
      }

      const isRpcLagging = !preTokenBalance || preTokenBalance.uiAmount === 0;

      if (isRpcLagging && amount === "auto") {
        throw new Error(`Cannot auto-sell: RPC reports 0 balance and no position amount provided.`);
      }

      let sellAmount: string;
      if (amount === "auto") {
        sellAmount = preTokenBalance!.amount.toString();
      } else {
        // Execute the Blind Sell using the exact amount recorded in our PositionStore
        sellAmount = Math.floor(amount * Math.pow(10, decimals)).toString();
        if (isRpcLagging) {
          logger.warn(`⚠️ RPC claims 0 balance for ${tokenMint}, but forcing BLIND SELL for ${amount} tokens to lock in 20% TSL.`);
        }
      }

      // 1. Get Jupiter Quote
      const quoteResponse = await this.getQuote(
        tokenMint,
        "So11111111111111111111111111111111111111112",
        sellAmount
      );
      if (!quoteResponse) throw new Error("Failed to get sell quote from Jupiter");

      // 3. Build Transaction with Dynamic Fees
      const { swapTransaction } = await this.getSwapTransaction(quoteResponse);

      // 4. 🚀 Fire and Confirm via Helius Sender Tunnel
      const tippedTransaction = await this.injectJitoTipAndSign(swapTransaction);
      // Pass the tippedTx for Plan A, and the pure swapTransaction for Plan B
      const txid = await this.broadcastViaSender(tippedTransaction, swapTransaction);
      const latency = (Date.now() - start) / 1000;

      logger.info(`✅ SELL CONFIRMED (WSS): ${tokenMint} -> ${txid} (${latency.toFixed(2)}s)`);
      return { success: true, txid, latency };

    } catch (err: any) {
      const latency = (Date.now() - start) / 1000;
      logger.error(`❌ SELL FAILED: ${err.message}`);
      return { success: false, error: err.message || String(err), latency };
    }
  }

  /**
     * 🛡️ JITO TIP INJECTOR
     * Decompiles the Jupiter transaction, adds a dynamic Jito tip, and recompiles.
     */
  private async injectJitoTipAndSign(swapTransactionBase64: string): Promise<VersionedTransaction> {
    // 1. Deserialize the Jupiter transaction
    const jupiterTransaction = VersionedTransaction.deserialize(Buffer.from(swapTransactionBase64, 'base64'));

    // 2. Get the Address Lookup Tables required for decompilation
    const altAccountResponses = await Promise.all(
      jupiterTransaction.message.addressTableLookups.map(l => this.connection.getAddressLookupTable(l.accountKey))
    );

    const altAccounts: AddressLookupTableAccount[] = altAccountResponses.map(item => {
      if (item.value == null) throw new Error("ALT is null");
      return item.value;
    });

    // 3. Decompile the message
    let decompiledMessage = TransactionMessage.decompile(jupiterTransaction.message, {
      addressLookupTableAccounts: altAccounts,
    });

    // 4. Add the Jito Tip Instruction (Hardcoded to 0.0005 SOL to outbid the 0.0002 minimum)
    const randomTipAccount = TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];
    const transferIx = SystemProgram.transfer({
      fromPubkey: this.keypair.publicKey,
      toPubkey: new PublicKey(randomTipAccount),
      lamports: 0.0002 * LAMPORTS_PER_SOL,
    });

    decompiledMessage.instructions.push(transferIx);

    // 5. Compile and Sign
    const transaction = new VersionedTransaction(decompiledMessage.compileToV0Message(altAccounts));
    transaction.sign([this.keypair]);

    return transaction;
  }

  /**
   * 🚀 HELIUS SENDER TUNNEL (AXIOS STABILIZED)
   * Sends the fully compiled, tipped transaction directly to the East Coast Block Builders.
   */
  // 🛡️ THE FIX: Notice the new second parameter 'rawJupiterTxBase64'
  private async broadcastViaSender(transaction: VersionedTransaction, rawJupiterTxBase64: string): Promise<string> {
    const serializedTx = Buffer.from(transaction.serialize()).toString('base64');
    let txid: string;

    try {
      const response = await axios.post(SENDER_ENDPOINT, {
        jsonrpc: '2.0',
        id: Date.now().toString(),
        method: 'sendTransaction',
        params: [
          serializedTx,
          {
            encoding: 'base64',
            skipPreflight: true, 
            maxRetries: 0
          }
        ]
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
        family: 4,
        httpsAgent 
      });

      if (response.data.error) {
        throw new Error(response.data.error.message);
      }
      txid = response.data.result;

    } catch (e: any) {
      const errMsg = e.response?.data?.error?.message || e.response?.data?.error || e.message;
      const statusCode = e.response?.status;
      
      if (statusCode === 500 || errMsg.includes('500') || errMsg.includes('too large')) {
        logger.warn(`⚠️ Helius Sender Choked on Tip Bloat. Falling back to pure, un-tipped Jupiter transaction...`);
        try {
          // 🛡️ THE TRUE FAILOVER: We deserialize the ORIGINAL, un-bloated Jupiter string
          const fallbackTx = VersionedTransaction.deserialize(Buffer.from(rawJupiterTxBase64, 'base64'));
          fallbackTx.sign([this.keypair]);

          txid = await this.connection.sendRawTransaction(fallbackTx.serialize(), {
            skipPreflight: true,
            maxRetries: 5 
          });
        } catch (fallbackError: any) {
          throw new Error(`Native RPC Failover rejected transaction: ${fallbackError.message}`);
        }
      } else {
        throw new Error(`Helius Sender rejected transaction: ${errMsg}`);
      }
    }

    // 🛡️ RESEARCHED FIX: Lightning-Fast WSS Confirmation (REMAINS EXACTLY THE SAME)
    return new Promise((resolve, reject) => {
      let settled = false;

      const subId = this.connection.onSignature(
        txid,
        (result) => {
          if (settled) return;
          settled = true;
          this.connection.removeSignatureListener(subId).catch(() => { });

          if (result.err) {
            reject(new Error(`Transaction failed on-chain: ${JSON.stringify(result.err)}`));
          } else {
            resolve(txid);
          }
        },
        "confirmed"
      );

      // Hard Timeout Guard (25 seconds)
      setTimeout(() => {
        if (!settled) {
          settled = true;
          this.connection.removeSignatureListener(subId).catch(() => { });
          reject(new Error("Helius Sender WSS Confirmation Timeout. Transaction dropped."));
        }
      }, 25000);
    });
  }

  // --- RETAINED JUPITER & BALANCE LOGIC BELOW ---

  private async getQuote(inputMint: string, outputMint: string, amount: string): Promise<any> {
    try {
      const slippageBps = cfg.slippage * 100;

      const response = await axios.get(`https://api.jup.ag/swap/v1/quote`, {
        params: {
          inputMint, outputMint, amount,
          slippageBps: slippageBps.toString(),
          onlyDirectRoutes: "false",
          asLegacyTransaction: "false",
          maxAccounts: "50"
        },
        timeout: 5000,
        httpsAgent, // 🛡️ CRITICAL FIX: Injected to prevent ECONNRESET on Jupiter
        family: 4,
        headers: {
          'Accept': 'application/json',
          // 🛡️ DUAL-KEY ARCHITECTURE: Protects execution quota
          'x-api-key': cfg.jupiterQuoteApiKey
        }
      });

      return response.data;
    } catch (error: any) {
      const msg = error.response?.data?.error || error.message;
      throw new Error(`Jupiter V1 Quote Fail: ${msg}`);
    }
  }

  private async getSwapTransaction(quoteResponse: any): Promise<any> {
    try {
      const priorityFee = await this.calculateRobustPriorityFee();
      const swapPayload = {
        quoteResponse: quoteResponse,
        userPublicKey: this.keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: priorityFee,
        dynamicComputeUnitLimit: true,
      };

      const response = await axios.post('https://api.jup.ag/swap/v1/swap', swapPayload, {
        headers: {
          'Content-Type': 'application/json',
          // 🛡️ DUAL-KEY ARCHITECTURE: Protects execution quota
          'x-api-key': cfg.jupiterQuoteApiKey
        },
        timeout: 5000,
        family: 4,
        httpsAgent // 🛡️ CRITICAL FIX: Injected to prevent ECONNRESET on Jupiter
      });

      return { swapTransaction: response.data.swapTransaction };
    } catch (error: any) {
      const msg = error.response?.data?.error || error.message;
      throw new Error(`Jupiter V1 Swap Fail: ${msg}`);
    }
  }

  /**
   * 🛡️ INSTITUTIONAL FIX: Sequential Background Priority Fee Poller
   * Uses recursive setTimeout to guarantee we never stack requests in the event loop,
   * preventing HTTP 429 Rate Limit cascades during network degradation.
   */
  private startPriorityFeePolling() {
    const poll = async () => {
      try {
        let fees = await this.connection.getRecentPrioritizationFees();
        const nonZeroFees = fees.map(f => f.prioritizationFee).filter(fee => fee > 0).sort((a, b) => b - a);

        let base = cfg.minPriorityFee || 10000;
        if (nonZeroFees.length >= 20) {
          // Constantly track the 75th percentile of global network fees
          const idx = Math.floor(nonZeroFees.length * 0.25);
          base = nonZeroFees[idx];
        }
        this.baselinePriorityFee = base;
      } catch (error) {
        // Silent catch: if RPC fails, we just seamlessly use the last known good baseline
      } finally {
        // Recursively call setTimeout ONLY after the previous request completely resolves or fails
        this.feePollingInterval = setTimeout(poll, 1500);
      }
    };

    poll(); // Kick off the initial loop
  }

  /**
   * 🛡️ API SAVER FIX: Just-In-Time (JIT) Priority Fee Calculation
   * Only burns an API token exactly when a trade is being executed.
   */
  private async calculateRobustPriorityFee(): Promise<number> {
    let base = cfg.minPriorityFee || 10000;

    try {
      // Burn 1 Helius token ONLY right before we need to route the trade
      let fees = await this.connection.getRecentPrioritizationFees();
      const nonZeroFees = fees.map(f => f.prioritizationFee).filter(fee => fee > 0).sort((a, b) => b - a);

      if (nonZeroFees.length >= 20) {
        const idx = Math.floor(nonZeroFees.length * 0.25);
        base = nonZeroFees[idx];
      }
    } catch (error) {
      // If the RPC hiccups, silently fall back to the safe minimum so the trade doesn't fail
      logger.warn("⚠️ JIT Fee check failed, using safe baseline.");
    }

    const attempt = Math.max(1, this._attemptCtx || 1);
    const escalationMultiplier = 1 + ((attempt - 1) * 0.15);
    const urgentFee = Math.floor(base * (cfg.priorityFeeMultiplier || 1) * escalationMultiplier);

    return Math.min(Math.max(urgentFee, cfg.minPriorityFee || 10000), cfg.maxPriorityFee || 5000000);
  }

  /**
   * 🛡️ INSTITUTIONAL FIX: Program-Aware Balance Resolution
   * Automatically detects Token-2022 contracts and derives the correct ATA.
   * Eliminates the "Phantom Balance" panic trap for new Solana standards.
   */
  async getTokenBalance(tokenMint: string): Promise<TokenBalance | null> {
    try {
      const mintPublicKey = new PublicKey(tokenMint);

      // 1. Fetch Mint Info FIRST to detect if this is a Token-2022 contract
      const mintInfo = await this.connection.getParsedAccountInfo(mintPublicKey);
      if (!mintInfo.value) return null;

      const isToken2022 = mintInfo.value.owner.toString() === TOKEN_2022_PROGRAM_ID.toString();
      const tokenProgram = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

      // 2. Calculate the correct Associated Token Address based on the specific Program ID
      const ataAddress = await getAssociatedTokenAddress(
        mintPublicKey,
        this.keypair.publicKey,
        false,
        tokenProgram
      );

      try {
        // 3. Read the account data using the correct program ID
        const accountInfo = await getAccount(this.connection, ataAddress, undefined, tokenProgram);

        let decimals = 9;
        if (mintInfo.value.data && 'parsed' in mintInfo.value.data) {
          decimals = mintInfo.value.data.parsed.info.decimals;
        }

        const amount = accountInfo.amount;

        // 4. Safe UI conversion. Note: We strictly preserve the raw BigInt 'amount' 
        // for Jupiter routing to prevent precision loss on 0-decimal memecoins.
        const uiAmount = Number(amount) / Math.pow(10, decimals);

        return { amount, decimals, uiAmount, uiAmountString: uiAmount.toString() };
      } catch (e) {
        if (e instanceof TokenAccountNotFoundError) return { amount: BigInt(0), decimals: 9, uiAmount: 0, uiAmountString: "0" };
        throw e;
      }
    } catch (error) {
      return null;
    }
  }

  async getSolBalance(): Promise<number> {
    try {
      return (await this.connection.getBalance(this.keypair.publicKey)) / 1e9;
    } catch (error) {
      return 0;
    }
  }
}