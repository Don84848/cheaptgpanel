# Telegram Bot — Cloudflare Worker

This is the Telegram bot deployed as a Cloudflare Worker.

## Setup

### 1. Install dependencies
```bash
cd bot-worker
npm install
```

### 2. Configure secrets in Cloudflare Dashboard
Go to **Workers & Pages → telegram-bot → Settings → Variables & Secrets** and add:

| Secret | Value |
|--------|-------|
| `TELEGRAM_BOT_TOKEN` | Your bot token (from @BotFather) |
| `TURSO_DATABASE_URL` | `libsql://telegram-panel-bot-elonmusc.aws-ap-northeast-1.turso.io` |
| `TURSO_AUTH_TOKEN` | Your Turso auth token |
| `ADMIN_WEBHOOK_SECRET` | Any random string (e.g. `my-secret-123`) |

### 3. Deploy
```bash
npm run deploy
```

### 4. Register the webhook
After deploying, run:
```bash
TELEGRAM_BOT_TOKEN=xxx WORKER_URL=https://telegram-bot.YOUR_SUBDOMAIN.workers.dev ADMIN_WEBHOOK_SECRET=my-secret-123 node set-webhook.mjs
```

Your bot is now live!

## Bot Flow

1. User sends `/start`
2. If a required channel is set → shows "Join Channel" button
3. After joining → shows 3 service buttons:
   - **Cheap OTPs Bot** — Browse countries & services (otpget.com)
   - **Cheap Gift Cards Bot** — Browse categories & products (g2bulk.com)
   - **Cheap TG Services Bot** — Browse SMM services (smmmain.com)

## Admin Panel

Manage the bot via the admin panel at your Replit deployment URL:
- Set the required channel
- Configure API keys for all 3 services
- Set markup percentage
- View users, transactions, stats
- Send broadcast messages
