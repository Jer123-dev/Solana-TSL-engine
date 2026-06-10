import dotenv from "dotenv";
dotenv.config();

interface Config {
  rpcUrl: string;
  privateKey: string;
  dexWs: string;
  dexRest: string;
  amount: number;
  slippage: number;
  maxPositions: number;
  trailingStop: number;
  metricsPort: number;
  // Add these new properties
  priorityFeeMultiplier: number;
  minPriorityFee: number;
  maxPriorityFee: number;
  wssUrl: string; // 🛡️ FIX: Renamed to match index.ts
  telegramBotToken: string; // 🛡️ FIX: Added missing Telegram config
  telegramChatId: string;   // 🛡️ FIX: Use string for Chat IDs (they can be large negatives)
  heliusSenderUrl: string; // 🛡️ NEW: Extracted Helius Sender
  jupiterPriceApiKey: string;
  jupiterQuoteApiKey: string;
  pollingIntervalMs: number;
}

const cfg: Config = {
  rpcUrl: process.env.RPC_URL!,
  privateKey: process.env.PRIVATE_KEY!,
  dexWs: process.env.DEXSCREENER_WS!,
  dexRest: process.env.DEXSCREENER_REST!,
  amount: parseFloat(process.env.AMOUNT!),
  slippage: parseInt(process.env.SLIPPAGE!),
  maxPositions: parseInt(process.env.MAX_POSITIONS!),
  trailingStop: parseFloat(process.env.TRAILING_STOP!),
  metricsPort: parseInt(process.env.METRICS_PORT!),
  priorityFeeMultiplier: parseFloat(process.env.PRIORITY_FEE_MULTIPLIER!),
  minPriorityFee: parseInt(process.env.MIN_PRIORITY_FEE!),
  maxPriorityFee: parseInt(process.env.MAX_PRIORITY_FEE!),
  wssUrl: process.env.WSS_URL || process.env.WS_URL!, // 🛡️ Safely accepts both env vars
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
  telegramChatId: process.env.TELEGRAM_CHAT_ID!,
  heliusSenderUrl: process.env.HELIUS_SENDER_URL!,
  jupiterPriceApiKey: process.env.JUPITER_PRICE_API_KEY!,
  jupiterQuoteApiKey: process.env.JUPITER_QUOTE_API_KEY!,
  pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || "1100"), // Default to 1.1s for safety
};

// 🛡️ FIX: Strict Boot Validation
if (!cfg.rpcUrl || !cfg.privateKey) {
  throw new Error("❌ FATAL: Missing RPC_URL or PRIVATE_KEY in .env");
}
if (!cfg.telegramBotToken || !cfg.telegramChatId) {
  throw new Error("❌ FATAL: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env. Bot cannot start.");
}

export default cfg;