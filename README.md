# EGENT Verify Bot — @EgentVerifybot

Verifies EGENT Packs free-mint tasks. Tasks 1+2 (Follow, Like & Repost) are
click-to-complete on the mint website. This bot checks tasks 3+4 automatically:
- Create post on X — via free oEmbed + text match
- Join t.me/ET_EGENT — via Telegram getChatMember (bot is admin)

Run: `npm install && node src/index.js`
Env (.env): BOT_TOKEN, OWNER_TELEGRAM_ID, PORT
HTTP API: GET /health, POST /verify, GET /status?wallet=0x...
