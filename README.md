# Institutional-Grade Solana Sniper & Trailing Stop-Loss Engine

Welcome to the ultimate high-frequency Solana Trading and Trailing Stop-Loss (TSL) Bot. Built for speed, precision, and reliability, this engine uses advanced routing and dedicated RPC tunnels to ensure your trades execute before the crowd.

## 🏗️ Architecture Overview

The system is designed with a high-performance modular architecture, isolating price feeds from transaction execution to ensure zero bottlenecks.

```text
+-------------+       +-------------------+       +------------------------------------+
|             |       |                   |       | 1. Dual-Key Jupiter Polling (Price)|
| Telegram UI | ----> | Buy/Sell Managers | ----> | 2. Helius WSS (Dump Detection)     |
|             |       |                   |       +------------------------------------+
+-------------+       +-------------------+                        |
                                                                   v
                                                  +------------------------------------+
                                                  | Helius Staked Sender Tunnel        |
                                                  | (Direct Validator Routing)         |
                                                  +------------------------------------+
                                                                   |
                                                                   v
                                                          +----------------+
                                                          | Solana Mainnet |
                                                          +----------------+
```

## 🛡️ The Jupiter Dual-Key System (Crucial Setup)

This bot employs a specialized **Dual-Key Jupiter Architecture** to handle high-frequency price polling and transaction quotes without hitting rate limits. 

Jupiter's free tier is strictly limited to 1 Request Per Second (RPS). Polling token prices every second will instantly trigger `429 Too Many Requests` rate limits on free plans, halting your operations.

To bypass this, we split the load:
1. **`JUPITER_PRICE_API_KEY`**: This key is responsible for constant, high-frequency price polling. **It MUST be tied to a Paid Jupiter Plan**. 
2. **`JUPITER_QUOTE_API_KEY`**: This key is used exclusively for fetching quotes and routing the actual swaps. It can remain on the Free Plan for standard users, though a Paid Plan is highly recommended for high-volume, institutional sniping.

## 🚀 The Helius Infrastructure (Crucial Warning)

Speed is everything on Solana. To guarantee immediate execution, this bot utilizes the `sender.helius-rpc.com` tunnel.

**⚠️ IMPORTANT WARNING:** 
This tunnel bypasses standard RPC queues and sends your transactions directly to staked validators. **This requires a Paid Helius Plan**. If you attempt to use the Helius Staked Sender Tunnel on a free tier, your transactions will fail to route. Ensure your API key has the necessary permissions and plan level.

## ⚙️ Quick Start

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
3. Configure your `.env` file following the strict requirements outlined above.
4. Start the engine:
   ```bash
   npm start
   ```

## 📞 Contact & Custom Builds

Facing issues, or looking to build a custom execution system? My DMs are always open. 
Reach out on Telegram: **[@Jerrooooo](https://t.me/Jerrooooo)**

---

## ☕ Support the Developer

If this open-source bot made you money, consider dropping a tip! Your support helps maintain the infrastructure and fund future alpha releases.

**Solana Tip Address:**
`vHRCCSnkwEZHQkw9cApDJKWQvTKG7Z1fxrp23h9SH7Y`

<p align="left">
  <img src="./qr.png" alt="Solana Tip QR Code" width="300"/>
</p>
*(Save the QR image provided as `qr.png` in the project root to display it here)*
