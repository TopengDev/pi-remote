# pi-remote — Telegram → Attn → Pi Remote Control

Bridge that lets Christopher control his Windows pi coding agent from Telegram, anywhere.

## Architecture

```
Telegram (@ChillPiBot) → VPS Docker (attn + bot) → attn relay → Windows pi
                                                          ← (reply)
```

## Setup

### Prerequisites
- Docker + Docker Compose
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- Your Telegram numeric user ID (from [@userinfobot](https://t.me/userinfobot))
- Windows pi running with attn daemon

### Deploy

```bash
cp .env.example .env
# Edit .env with your TELEGRAM_BOT_TOKEN and SUPERUSER_TG_ID
docker compose up -d --build
```

### Verify

```bash
docker compose ps          # both services should be UP
docker compose exec attn node -e "require('http').get('http://localhost:9742/status',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))})"
# Should show: relayConnected: true
```

Send a message to your bot on Telegram — it should forward to your pi.

## Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Service definitions |
| `.env.example` | Required environment variables |
| `attn-core/Dockerfile` | Multi-stage build for attn daemon |
| `attn-core/src/` | attn daemon source (from attn-core) |
| `bot/Dockerfile` | Telegram bot container |
| `bot/bot.js` | Grammy bot — forwards TG messages to pi via attn |
| `bot/package.json` | Bot dependencies |

## Security

- Bot token lives in `.env` (gitignored), never in code or images
- Telegram auth: only the configured numeric user ID can send commands
- Attn auth: all messages are E2E encrypted via the attn relay
- The bot forwards messages but never executes them — execution happens on the pi side
