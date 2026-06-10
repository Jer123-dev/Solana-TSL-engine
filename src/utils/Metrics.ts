import client from "prom-client";
import cfg from "../config";

client.collectDefaultMetrics();
export const tradeLatency = new client.Histogram({
  name: "trade_latency_seconds",
  help: "Latency of trade execution",
  buckets: [0.1, 0.5, 1, 2, 5],
});
export const tradeSuccess = new client.Counter({
  name: "trade_success_total",
  help: "Total successful trades",
});
export const tradeFailure = new client.Counter({
  name: "trade_failure_total",
  help: "Total failed trades",
});

export function startMetricsServer() {
  import("http").then(({ createServer }) => {
    // 🛡️ INSTITUTIONAL FIX: Added 'async' to the request handler
    createServer(async (req, res) => {
      if (req.url === "/metrics") {
        res.setHeader("Content-Type", client.register.contentType);
        // 🛡️ INSTITUTIONAL FIX: Await the metrics promise so it returns actual data
        const metricsData = await client.register.metrics();
        res.end(metricsData);
      } else {
        res.writeHead(404);
        res.end();
      }
    }).listen(cfg.metricsPort, () => {
      console.log(`Metrics server listening on ${cfg.metricsPort}`);
    });
  });
}

