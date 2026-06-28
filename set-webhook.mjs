/**
 * Run this once after deploying to Cloudflare Workers to register the webhook.
 * Usage: TELEGRAM_BOT_TOKEN=xxx WORKER_URL=https://telegram-bot.YOUR_SUBDOMAIN.workers.dev node set-webhook.mjs
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const workerUrl = process.env.WORKER_URL;
const secret = process.env.ADMIN_WEBHOOK_SECRET || "changeme";

if (!token || !workerUrl) {
  console.error("Set TELEGRAM_BOT_TOKEN and WORKER_URL environment variables");
  process.exit(1);
}

const webhookUrl = `${workerUrl}/webhook`;
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: webhookUrl, secret_token: secret, drop_pending_updates: true }),
});
const data = await res.json();
console.log("Webhook set:", data);
