import EventEmitter from 'events';
import TelegramBot from 'node-telegram-bot-api';
import logger from '../utils/Logger';
import cfg from '../config';

export class TelegramController extends EventEmitter {
  private bot: TelegramBot;
  private processedTokens = new Set<string>();
  private authorizedChatId: number;

  constructor() {
    super();

    // Strict configuration check for institutional-grade reliability
    if (!cfg.telegramBotToken || !cfg.telegramChatId) {
      throw new Error("CRITICAL: Telegram credentials missing in config.ts");
    }

    // 🛡️ FATAL FIX: Force conversion to Number to match msg.chat.id type
    this.authorizedChatId = Number(cfg.telegramChatId);

    if (isNaN(this.authorizedChatId)) {
      logger.error("❌ CRITICAL: TELEGRAM_CHAT_ID in .env is not a valid number!");
    }

    // Initialize without starting polling immediately (handled in start())
    this.bot = new TelegramBot(cfg.telegramBotToken, { polling: false });
  }

  /**
   * Boots the Telegram polling service and attaches listeners.
   */
  async start(): Promise<void> {
    try {
      await this.bot.startPolling();
      logger.info(`🤖 Telegram UI Controller ready. Secured to Chat ID: ${this.authorizedChatId}`);

      this.bot.on('message', (msg) => this.handleMessage(msg));

      this.bot.on('polling_error', (error) => {
        // Keeps the systemd service alive during temporary Telegram API outages
        logger.error(`Telegram network/polling error: ${error.message}`);
      });
    } catch (error: any) {
      logger.error(`Failed to boot Telegram Controller: ${error.message}`);
    }
  }

  /**
   * Processes incoming messages, authenticates the sender, and validates Solana addresses.
   */
  private handleMessage(msg: TelegramBot.Message): void {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();

    // SECURITY LEVEL 1: Hard block any user that is not you
    if (chatId !== this.authorizedChatId) {
      logger.warn(`Unauthorized Snipe attempt blocked from Chat ID: ${chatId}`);
      return;
    }

    if (!text) return;

    // Check for standard bot commands
    if (text === '/start' || text === '/help') {
      this.sendAlert("🟢 <b>Sniper System Active.</b>\n\nPaste any Solana contract address below to initiate the execution engine.");
      return;
    }

    // SECURITY LEVEL 2: Strict Base58 Solana Address Validation (32-44 chars)
    // Prevents garbage data from reaching the Swap Engine
    const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

    if (solanaAddressRegex.test(text)) {
      if (!this.processedTokens.has(text)) {
        this.processedTokens.add(text);

        logger.info(`⚡ INSTANT TELEGRAM DETECTION: ${text}`);

        // Acknowledge receipt to the user instantly
        this.sendAlert(`⏳ <b>Target Locked:</b> <code>${text}</code>\nInitiating Jupiter Routing...`);

        // Emit to BuyManager (maintains pure EventEmitter architecture)
        this.emit('newToken', text);
      } else {
        this.sendAlert(`⚠️ <b>Duplicate Ignored:</b> This token is already in the execution or active position queue.`);
      }
    } else {
      this.sendAlert(`❌ <b>Invalid Input:</b> The text provided is not a valid Solana contract address.`);
    }
  }

  /**
   * Public method for BuyManager/SellManager to push telemetry back to your phone.
   * @param message The HTML formatted string to send.
   */
  async sendAlert(message: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.authorizedChatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true // Keeps the chat clean from random token metadata links
      });
    } catch (error: any) {
      logger.error(`Failed to dispatch Telegram alert: ${error.message}`);
    }
  }

  /**
   * 🛡️ INSTITUTIONAL FIX: Memory Leak & Re-Snipe Fix
   * Removes a token from the processed list after it's sold, allowing you to buy the dip later.
   */
  clearProcessedToken(mint: string): void {
    this.processedTokens.delete(mint);
    logger.info(`♻️ Cleared ${mint} from Telegram memory. Ready for re-snipe.`);
  }

  /**
   * Clean teardown for application shutdown.
   */
  destroy(): void {
    if (this.bot) {
      this.bot.stopPolling();
      logger.info("Telegram Controller destroyed cleanly");
    }
  }
}