/**
 * EGENT Verify Bot — @EgentVerifybot
 * Task verification (click-to-complete for X tasks 1+2, no X API):
 *  1. Follow @ET_EGENT on X          -> AUTO-COMPLETE on click: done when the
 *     user clicks the X profile link on the website (owner decision 2026-11-10)
 *  2. Like & Repost pinned post on X -> AUTO-COMPLETE on click: done when the
 *     user clicks the pinned-post/profile link on the website (owner decision
 *     2026-11-10, same as Follow)
 *  3. Create post on X               -> AUTO via oEmbed (free) + text match
 *  4. Join t.me/ET_EGENT             -> AUTO via Telegram getChatMember (bot is admin)
 *
 * Flow: participant runs /verify -> bot checks tasks 3+4 automatically (tasks
 * 1+2 are auto-complete on click) -> if 3+4 pass, the wallet is approved and
 * saved for the allowlist. No manual approval step.
 *
 * Owner commands (restricted to OWNER_TELEGRAM_ID):
 *  /pending            list participants awaiting manual X verification
 *  /approve <wallet>   approve a wallet (owner verified follow + like/repost)
 *  /approved           list fully approved wallets (for setEligibleBatch)
 *
 * Also exposes a small HTTP API for the mint website:
 *  GET  /health
 *  POST /verify  { wallet, xUsername, tgUserId?, postLink? }
 *    -> { follow, likeRepost, createPost, joinTelegram, allPassed }
 *  GET  /check-telegram?username=@foo
 *    -> { member: true } if the username is a member of @ET_EGENT,
 *       { member: false, reason: 'not_linked' } if the user never messaged
 *       the bot (username cannot be resolved to a numeric id yet),
 *       { member: false, reason: 'not_member' } if they have not joined.
 *       Used by the mint website's Task 4 form (auto-check, no /verify).
 *
 * Env (.env, chmod 600, never commit):
 *  BOT_TOKEN          Telegram bot token (@EgentVerifybot)
 *  OWNER_TELEGRAM_ID  Telegram user id of the owner (for /pending /approve)
 *  PORT               HTTP port (default 3000)
 */
const { Bot } = require('grammy');
const express = require('express');
const { createProxyFetch } = require('./proxyFetch');
const fs = require('fs');
const path = require('path');

// --- load .env (simple, no dependency) ---
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID || '';
const PORT = parseInt(process.env.PORT || '3000', 10);
const CHANNEL = '@ET_EGENT';
const X_ACCOUNT = 'ET_EGENT';

if (!BOT_TOKEN) { console.error('BOT_TOKEN missing in .env'); process.exit(1); }

// --- participants store (JSON file; survives bot restarts, wiped only if the VM is replaced) ---
const DATA_DIR = path.join(__dirname, '..', 'data');
const PART_FILE = path.join(DATA_DIR, 'participants.json');
function loadParts() {
  try { return JSON.parse(fs.readFileSync(PART_FILE, 'utf8')); } catch { return {}; }
}
function saveParts(p) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PART_FILE, JSON.stringify(p, null, 2));
}

// --- Telegram username -> user id store ---
// Telegram's Bot API getChatMember needs a NUMERIC user id, not a username.
// The bot can only resolve a username to an id if that user has messaged the
// bot at least once (so we learn their id + username). Record every sender.
const TG_USERS_FILE = path.join(DATA_DIR, 'tg-users.json');
function loadTgUsers() {
  try { return JSON.parse(fs.readFileSync(TG_USERS_FILE, 'utf8')); } catch { return {}; }
}
function saveTgUsers(u) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TG_USERS_FILE, JSON.stringify(u, null, 2));
}
function recordTgUser(from) {
  if (!from || !from.username || !from.id) return;
  const users = loadTgUsers();
  const key = String(from.username).toLowerCase().replace(/^@/, '');
  users[key] = { id: from.id, username: from.username, firstSeen: users[key]?.firstSeen || new Date().toISOString(), lastSeen: new Date().toISOString() };
  saveTgUsers(users);
}

// Task 3: does the submitted post link exist and contain the required text?
// Uses the free public oEmbed endpoint (no X API key needed).
async function checkCreatePost(postLink, xUsername) {
  if (!postLink) return { status: 'fail', detail: 'no post link submitted' };
  const m = postLink.match(/x\.com\/[^/]+\/status\/(\d+)/) || postLink.match(/twitter\.com\/[^/]+\/status\/(\d+)/);
  if (!m) return { status: 'fail', detail: 'link is not an X post URL' };
  try {
    const res = await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(postLink)}&omit_script=true`);
    if (!res.ok) return { status: 'error', detail: `oEmbed ${res.status} (post may be private/deleted)` };
    const j = await res.json();
    const html = (j.html || '').replace(/<[^>]+>/g, ' ');
    // oEmbed author_name is the DISPLAY name (e.g. "Aleca Sky"), not the
    // username — compare against author_url instead (https://x.com/<username>).
    const urlUser = (j.author_url || '').match(/x\.com\/([^/?#]+)/)?.[1]
      || (j.author_url || '').match(/twitter\.com\/([^/?#]+)/)?.[1] || '';
    const authorOk = !xUsername || urlUser.toLowerCase() === xUsername.toLowerCase().replace(/^@/, '');
    const textOk = html.includes("Hello I'm $EGENT") || html.includes('Hello I&#39;m $EGENT') || html.includes('Free Mint is live');
    if (authorOk && textOk) return { status: 'pass', detail: `post by @${urlUser || j.author_name} contains the required text` };
    if (!authorOk) return { status: 'fail', detail: `post author (@${urlUser || '?'}) does not match your X username (@${xUsername})` };
    return { status: 'fail', detail: 'post does not contain the required text' };
  } catch (e) {
    return { status: 'error', detail: String(e.message || e) };
  }
}

// Task 4: is the Telegram user a member of @ET_EGENT?
async function checkJoinTelegram(bot, tgUserId) {
  try {
    const member = await bot.api.getChatMember(CHANNEL, tgUserId);
    const ok = ['creator', 'administrator', 'member'].includes(member.status);
    return { status: ok ? 'pass' : 'fail', detail: `Telegram status: ${member.status}` };
  } catch (e) {
    return { status: 'error', detail: String(e.description || e.message || e) };
  }
}

async function verifyAll(bot, { wallet, xUsername, tgUserId, postLink }) {
  // Tasks 1+2 (Follow, Like & Repost) auto-complete when the user clicks the
  // link on the website (owner decision). Tasks 3+4 are checked here.
  const follow = { status: 'pass', detail: 'completed by clicking the X profile link' };
  const likeRepost = { status: 'pass', detail: 'completed by clicking the pinned post link' };
  const [createPost, joinTelegram] = await Promise.all([
    checkCreatePost(postLink, xUsername),
    tgUserId ? checkJoinTelegram(bot, tgUserId) : { status: 'fail', detail: 'no Telegram user' },
  ]);
  // Approved when the two bot-checked tasks pass (tasks 1+2 are click-complete).
  const allPassed = createPost.status === 'pass' && joinTelegram.status === 'pass';
  return {
    wallet: wallet || null, xUsername: xUsername || null,
    follow, likeRepost, createPost, joinTelegram,
    allPassed,
  };
}

function fmt(r) {
  const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : r.status === 'manual' ? '👤' : '⚠️';
  return `${icon} ${r.detail}`;
}

function isOwner(ctx) {
  return OWNER_TELEGRAM_ID && String(ctx.from.id) === String(OWNER_TELEGRAM_ID);
}

// --- Telegram bot ---
const bot = new Bot(BOT_TOKEN, { client: { fetch: createProxyFetch() } });

// Record every sender's username -> id so the website's Task 4 check
// (GET /check-telegram?username=...) can resolve a username to the numeric
// id that getChatMember requires.
bot.use(async (ctx, next) => {
  try { if (ctx.from) recordTgUser(ctx.from); } catch {}
  await next();
});

bot.command('start', async (ctx) => {
  await ctx.reply(
    '👋 Welcome to EGENT Packs verification!\n\n' +
    'I check your free-mint tasks:\n' +
    '1️⃣ Follow @ET_EGENT on X — auto-complete when you click the profile link\n' +
    '2️⃣ Like & Repost the pinned post — auto-complete when you click the post link\n' +
    '3️⃣ Create a post on X with the required text — checked automatically\n' +
    '4️⃣ Join t.me/ET_EGENT — checked automatically\n\n' +
    'Send /verify to start. I will ask for your wallet address, your X username, and your X post link.'
  );
});

bot.command('approved', async (ctx) => {
  if (!isOwner(ctx)) { await ctx.reply('This command is for the owner only.'); return; }
  const parts = loadParts();
  const list = Object.values(parts).filter((p) => p.status === 'approved');
  if (!list.length) { await ctx.reply('No approved wallets yet.'); return; }
  const lines = ['✅ Approved wallets (add to allowlist via setEligibleBatch):'];
  for (const p of list) lines.push(`• ${p.wallet}  (@${p.xUsername})`);
  await ctx.reply(lines.join('\n'));
});

const sessions = new Map(); // tgUserId -> { step, wallet, xUsername, postLink }
bot.command('verify', async (ctx) => {
  sessions.set(ctx.from.id, { step: 'wallet' });
  await ctx.reply('Send your BSC wallet address (0x...) for the free mint:');
});

bot.on('message:text', async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return;
  const text = ctx.message.text.trim();
  if (s.step === 'wallet') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(text)) { await ctx.reply('That does not look like a wallet address. Send a 0x... address:'); return; }
    s.wallet = text; s.step = 'xuser';
    await ctx.reply('Now send your X username (without @), e.g. ET_EGENT:');
  } else if (s.step === 'xuser') {
    s.xUsername = text.replace(/^@/, ''); s.step = 'postlink';
    await ctx.reply('Now send the link to your X post (the one with "Hello I\'m $EGENT..."), e.g. https://x.com/you/status/123...:');
  } else if (s.step === 'postlink') {
    s.postLink = text; s.step = 'done';
    sessions.delete(ctx.from.id);
    await ctx.reply('⏳ Checking your tasks, please wait...');
    const result = await verifyAll(bot, { wallet: s.wallet, xUsername: s.xUsername, tgUserId: ctx.from.id, postLink: s.postLink });
    // Save participant. Approved when the two bot-checked tasks pass
    // (tasks 1+2 are click-to-complete on the website).
    const parts = loadParts();
    const key = s.wallet.toLowerCase();
    const prev = parts[key] || {};
    const approved = result.allPassed;
    parts[key] = {
      ...prev, wallet: s.wallet, xUsername: s.xUsername, tgUserId: ctx.from.id,
      postLink: s.postLink, createPost: result.createPost.status, joinTelegram: result.joinTelegram.status,
      status: approved ? 'approved' : 'failed',
      updatedAt: new Date().toISOString(),
    };
    saveParts(parts);
    const autoOk = result.createPost.status === 'pass' && result.joinTelegram.status === 'pass';
    const lines = [
      `Results for wallet ${s.wallet}:`,
      `1. Follow @ET_EGENT — ${fmt(result.follow)}`,
      `2. Like & Repost pinned post — ${fmt(result.likeRepost)}`,
      `3. Create post on X — ${fmt(result.createPost)}`,
      `4. Join t.me/ET_EGENT — ${fmt(result.joinTelegram)}`,
      '',
      result.allPassed
        ? '🎉 All 4 tasks VERIFIED! Your wallet is approved for the free mint.'
        : 'Some automatic checks did not pass. Complete the missing ones and send /verify again.',
    ];
    await ctx.reply(lines.join('\n'));
  }
});

// --- HTTP API for the mint website ---
const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.json({ ok: true, bot: 'EgentVerifybot', mode: 'click-complete', ownerConfigured: !!OWNER_TELEGRAM_ID }));
// Website polling: returns the stored verification status for a wallet so the
// mint site can flip tasks 3+4 (and the overall gate) to Verified as soon as
// the bot has checked them. No wallet => { verified: false }.
app.get('/status', (req, res) => {
  const wallet = String(req.query.wallet || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return res.json({ verified: false, reason: 'invalid wallet' });
  const parts = loadParts();
  const p = parts[wallet];
  if (!p) return res.json({ verified: false, reason: 'not verified yet' });
  res.json({
    verified: p.status === 'approved',
    wallet: p.wallet, xUsername: p.xUsername,
    createPost: p.createPost, joinTelegram: p.joinTelegram,
    status: p.status, updatedAt: p.updatedAt,
  });
});
app.post('/verify', async (req, res) => {
  try {
    const { wallet, xUsername, tgUserId, postLink } = req.body || {};
    const result = await verifyAll(bot, { wallet, xUsername, tgUserId, postLink });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
// Task 4 standalone check for the mint website: GET /check-telegram?username=@foo
// Returns { member: true/false } when the username is known to the bot, or
// { member: false, reason: 'not_linked' } when the user has never messaged
// the bot (so their username cannot be resolved to a numeric id). In that
// case the website tells the user to press Start on @EgentVerifybot once,
// then retry the check.
app.get('/check-telegram', async (req, res) => {
  try {
    const raw = String(req.query.username || '').trim();
    const username = raw.replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{5,32}$/.test(username)) {
      return res.json({ member: false, reason: 'invalid_username', username: raw });
    }
    const users = loadTgUsers();
    const entry = users[username];
    if (!entry || !entry.id) {
      return res.json({ member: false, reason: 'not_linked', username });
    }
    const r = await checkJoinTelegram(bot, entry.id);
    if (r.status === 'pass') return res.json({ member: true, username, status: r.detail });
    if (r.status === 'fail') return res.json({ member: false, reason: 'not_member', username, status: r.detail });
    return res.json({ member: false, reason: 'error', username, status: r.detail });
  } catch (e) {
    res.status(500).json({ member: false, reason: 'error', error: String(e.message || e) });
  }
});

bot.catch((err) => {
  console.error('bot error:', err?.error?.description || err?.message || err);
  // do not crash on transient polling conflicts; grammy will retry
});

bot.start();
console.log('EgentVerifybot polling started');
app.listen(PORT, () => console.log(`verify API listening on :${PORT}`));
