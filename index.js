'use strict';
require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const { MongoClient, ObjectId } = require('mongodb');
const L = require('./lib');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
if (!BOT_TOKEN || !MONGODB_URI) {
  console.error('BOT_TOKEN va MONGODB_URI muhit o‘zgaruvchilari kerak (.env.example ga qarang)');
  process.exit(1);
}

// Kirish: ACCESS_CODE (parol) yuborgan har bir kishi a'zo bo'ladi (cheklanmagan).
// ALLOWED_IDS — parolsiz kiradigan ID lar (ixtiyoriy).
const ALLOWED = (process.env.ALLOWED_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
const NOTIFY = process.env.NOTIFY === '1'; // 1 bo'lsa, boshqa a'zolarga xabar boradi
if (!ACCESS_CODE && !ALLOWED.length) {
  console.error('ACCESS_CODE (parol) yoki ALLOWED_IDS kerak — bot begonalarga ochiq qolmasligi uchun');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const col = {};
const state = new Map(); // userId -> { type: 'in' | 'out', account? }

const menu = Markup.keyboard([
  ['➕ Kirim', '➖ Chiqim'],
  ['💰 Kassa', '📊 Oylik hisobot'],
  ['🕘 Oxirgilar', '❓ Yordam'],
]).resize();

// ---------- DB ----------
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME || 'kassa');
  col.tx = db.collection('transactions');
  col.members = db.collection('members');
  col.settings = db.collection('settings');
  await col.tx.createIndex({ createdAt: 1 });
  await col.settings.updateOne(
    { _id: 'accounts' },
    { $setOnInsert: { list: [1, 2, 3].map((id) => ({ id, name: `Hisob ${id}` })) } },
    { upsert: true },
  );
}

async function getAccounts() {
  return (await col.settings.findOne({ _id: 'accounts' })).list;
}

async function memberIds() {
  const reg = (await col.members.find().toArray()).map((m) => m._id);
  return [...new Set([...ALLOWED, ...reg])];
}

async function sums(from, to) {
  const match = { deletedAt: null };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = from;
    if (to) match.createdAt.$lt = to;
  }
  const rows = await col.tx.aggregate([
    { $match: match },
    { $group: { _id: { t: '$type', a: '$account' }, s: { $sum: '$amount' } } },
  ]).toArray();
  const r = { in: 0, out: 0, byAcc: { 1: 0, 2: 0, 3: 0 } };
  for (const x of rows) {
    if (x._id.t === 'in') r.in += x.s;
    else {
      r.out += x.s;
      r.byAcc[x._id.a] = (r.byAcc[x._id.a] || 0) + x.s;
    }
  }
  return r;
}

async function balance() {
  const t = await sums(null, null);
  return t.in - t.out;
}

// ---------- Ruxsat ----------
bot.use(async (ctx, next) => {
  const u = ctx.from;
  if (!u) return;
  const text = ctx.message?.text || '';

  if (/^\/myid(@\w+)?$/.test(text)) return ctx.reply(`Sizning Telegram ID: ${u.id}`);

  const ids = await memberIds();
  if (!ids.includes(u.id)) {
    const given = text.replace(/^\/start\s*/, '').trim();
    if (ACCESS_CODE && given === ACCESS_CODE) {
      await col.members.updateOne(
        { _id: u.id },
        { $setOnInsert: { name: L.displayName(u), joinedAt: new Date() } },
        { upsert: true },
      );
      await ctx.reply(`✅ Xush kelibsiz, ${L.displayName(u)}!\n\n${HELP}`, { parse_mode: 'HTML', ...menu });
      return;
    }
    if (ctx.callbackQuery) return ctx.answerCbQuery('Ruxsat yo‘q');
    return ctx.reply('🔒 Bu yopiq kassa boti. Kirish uchun parolni yuboring.');
  }
  return next();
});

// ---------- Yordamchilar ----------
async function notifyOthers(ctx, html) {
  if (!NOTIFY) return;
  for (const id of await memberIds()) {
    if (id === ctx.from.id) continue;
    bot.telegram.sendMessage(id, html, { parse_mode: 'HTML' }).catch(() => {});
  }
}

async function addTx(ctx, { type, account, amount, note }) {
  const doc = {
    type,
    account: type === 'out' ? account : null,
    amount,
    note: note || '',
    userId: ctx.from.id,
    userName: L.displayName(ctx.from),
    createdAt: new Date(),
    deletedAt: null,
  };
  const r = await col.tx.insertOne(doc);
  doc._id = r.insertedId;

  const [accounts, bal] = await Promise.all([getAccounts(), balance()]);
  const line = L.txLine(doc, accounts);
  await ctx.reply(
    `✅ Saqlandi:\n${line}\n\n💰 Kassa: <b>${L.som(bal)}</b>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🗑 Bekor qilish', `d:${doc._id}`)]]),
    },
  );
  await notifyOthers(ctx, `🔔 ${line}\n💰 Kassa: <b>${L.som(bal)}</b>`);
}

async function askAccount(ctx) {
  const accounts = await getAccounts();
  return ctx.reply(
    'Qaysi hisobdan chiqim?',
    Markup.inlineKeyboard(accounts.map((a) => [Markup.button.callback(`👤 ${a.name}`, `a:${a.id}`)])),
  );
}

function argsOf(ctx) {
  return ctx.message.text.replace(/^\/\w+(@\w+)?\s*/, '').trim();
}

const AMOUNT_HINT = 'Masalan: <code>50000 savdo</code>, <code>50 000</code>, <code>50k</code>, <code>1.5m</code>';

// ---------- Boshlash / yordam ----------
const HELP = `<b>Kassa boti</b>

➕ <b>Kirim</b> — umumiy kassaga pul kirimi
➖ <b>Chiqim</b> — 3 ta hisobdan biriga chiqim
💰 <b>Kassa</b> — joriy qoldiq
📊 <b>Oylik hisobot</b> — oy bo'yicha hamma amallar (sana va soat bilan), oldingi oylar, CSV
🕘 <b>Oxirgilar</b> — oxirgi 10 amal, xato bo'lsa o'chirish

<b>Tez buyruqlar:</b>
/kirim 50000 izoh
/chiqim 1 20000 izoh  (1, 2 yoki 3 — hisob raqami)
/hisobot  yoki  /hisobot 2026-10
/nom 1 Ali  — hisob nomini o'zgartirish
/bekor — joriy amalni bekor qilish
/myid — Telegram ID

Summa: <code>50000</code>, <code>50 000</code>, <code>1.500.000</code>, <code>50k</code>, <code>1.5m</code>`;

bot.start((ctx) => ctx.reply(`Salom! 👋\n\n${HELP}`, { parse_mode: 'HTML', ...menu }));
bot.command('yordam', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML', ...menu }));
bot.hears('❓ Yordam', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML', ...menu }));

bot.command('bekor', (ctx) => {
  state.delete(ctx.from.id);
  return ctx.reply('Bekor qilindi.', menu);
});

// ---------- Kirim ----------
async function startIncome(ctx) {
  state.set(ctx.from.id, { type: 'in' });
  return ctx.reply(`➕ Kirim summasini yozing (ixtiyoriy izoh bilan).\n${AMOUNT_HINT}\n\nBekor qilish: /bekor`, { parse_mode: 'HTML' });
}
bot.hears('➕ Kirim', startIncome);
bot.command('kirim', async (ctx) => {
  const args = argsOf(ctx);
  if (!args) return startIncome(ctx);
  const p = L.parseAmountText(args);
  if (!p) return ctx.reply(`❗️ Summani tushunmadim.\n${AMOUNT_HINT}`, { parse_mode: 'HTML' });
  state.delete(ctx.from.id);
  return addTx(ctx, { type: 'in', ...p });
});

// ---------- Chiqim ----------
bot.hears('➖ Chiqim', askAccount);
bot.command('chiqim', async (ctx) => {
  const args = argsOf(ctx);
  if (!args) return askAccount(ctx);
  const [first, ...rest] = args.split(/\s+/);
  if (!/^[1-3]$/.test(first)) {
    return ctx.reply('Format: <code>/chiqim 1 20000 izoh</code> (1, 2 yoki 3 — hisob raqami)', { parse_mode: 'HTML' });
  }
  const p = L.parseAmountText(rest.join(' '));
  if (!p) return ctx.reply(`❗️ Summani tushunmadim.\n${AMOUNT_HINT}`, { parse_mode: 'HTML' });
  state.delete(ctx.from.id);
  return addTx(ctx, { type: 'out', account: Number(first), ...p });
});

bot.action(/^a:([1-3])$/, async (ctx) => {
  const account = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  ctx.deleteMessage().catch(() => {});
  state.set(ctx.from.id, { type: 'out', account });
  const name = L.accName(await getAccounts(), account);
  return ctx.reply(
    `➖ <b>${L.esc(name)}</b> — chiqim summasini yozing (ixtiyoriy izoh bilan).\n${AMOUNT_HINT}\n\nBekor qilish: /bekor`,
    { parse_mode: 'HTML' },
  );
});

// ---------- Kassa ----------
bot.hears('💰 Kassa', async (ctx) => {
  const ym = L.currentYM();
  const { start, end } = L.monthRange(ym);
  const [accounts, all, cur] = await Promise.all([getAccounts(), sums(null, null), sums(start, end)]);
  let s = `💰 <b>Kassa qoldig'i: ${L.som(all.in - all.out)}</b>\n\n`;
  s += `📅 <b>${L.MONTHS[ym.m]} ${ym.y}</b>\n`;
  s += `➕ Kirim: ${L.som(cur.in)}\n`;
  s += `➖ Chiqim: ${L.som(-cur.out)}\n`;
  for (const a of accounts) s += `     👤 ${L.esc(a.name)}: ${L.som(-(cur.byAcc[a.id] || 0))}\n`;
  return ctx.reply(s, { parse_mode: 'HTML' });
});

// ---------- Hisobot ----------
async function sendReport(ctx, ym) {
  const { start, end } = L.monthRange(ym);
  const [accounts, before, cur, txs] = await Promise.all([
    getAccounts(),
    sums(null, start),
    sums(start, end),
    col.tx.find({ deletedAt: null, createdAt: { $gte: start, $lt: end } }).sort({ createdAt: 1 }).toArray(),
  ]);
  const { summary, chunks } = L.buildReport({
    ym, accounts, opening: before.in - before.out, cur, txs,
  });

  const isCurrent = L.ymKey(ym) === L.ymKey(L.currentYM());
  const prev = L.shiftYM(ym, -1);
  const next = L.shiftYM(ym, 1);
  const row = [Markup.button.callback(`◀️ ${L.MONTHS[prev.m]}`, `r:${L.ymKey(prev)}`)];
  if (!isCurrent) row.push(Markup.button.callback(`${L.MONTHS[next.m]} ▶️`, `r:${L.ymKey(next)}`));
  const kb = Markup.inlineKeyboard([row, [Markup.button.callback('📥 CSV (Excel)', `x:${L.ymKey(ym)}`)]]);

  await ctx.reply(summary, { parse_mode: 'HTML', ...(chunks.length ? {} : kb) });
  for (let i = 0; i < chunks.length; i++) {
    await ctx.reply(chunks[i], { parse_mode: 'HTML', ...(i === chunks.length - 1 ? kb : {}) });
  }
}

bot.hears('📊 Oylik hisobot', (ctx) => sendReport(ctx, L.currentYM()));
bot.command('hisobot', (ctx) => {
  const args = argsOf(ctx);
  const ym = args ? L.parseYM(args) : L.currentYM();
  if (!ym) return ctx.reply('Format: <code>/hisobot 2026-10</code>', { parse_mode: 'HTML' });
  return sendReport(ctx, ym);
});
bot.action(/^r:(\d{4}-\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const ym = L.parseYM(ctx.match[1]);
  if (ym) return sendReport(ctx, ym);
});
bot.action(/^x:(\d{4}-\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const ym = L.parseYM(ctx.match[1]);
  if (!ym) return;
  const { start, end } = L.monthRange(ym);
  const [accounts, txs] = await Promise.all([
    getAccounts(),
    col.tx.find({ deletedAt: null, createdAt: { $gte: start, $lt: end } }).sort({ createdAt: 1 }).toArray(),
  ]);
  const csv = L.toCsv(txs, accounts);
  return ctx.replyWithDocument(
    { source: Buffer.from(csv, 'utf8'), filename: `kassa-${L.ymKey(ym)}.csv` },
    { caption: `${L.MONTHS[ym.m]} ${ym.y} — ${txs.length} ta amal` },
  );
});

// ---------- Oxirgilar / o'chirish ----------
bot.hears('🕘 Oxirgilar', async (ctx) => {
  const [accounts, txs] = await Promise.all([
    getAccounts(),
    col.tx.find({ deletedAt: null }).sort({ createdAt: -1 }).limit(10).toArray(),
  ]);
  if (!txs.length) return ctx.reply('Hali amallar yo‘q.');
  const lines = txs.map((t, i) => `${i + 1}. ${L.txLine(t, accounts)}`);
  const buttons = txs.map((t, i) => Markup.button.callback(`🗑 ${i + 1}`, `d:${t._id}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(buttons.slice(i, i + 5));
  return ctx.reply(`🕘 <b>Oxirgi amallar</b> (o'chirish uchun raqamni bosing):\n\n${lines.join('\n')}`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(rows),
  });
});

bot.action(/^d:([a-f0-9]{24})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tx = await col.tx.findOne({ _id: new ObjectId(ctx.match[1]), deletedAt: null });
  if (!tx) return ctx.reply('Bu amal allaqachon o‘chirilgan.');
  const accounts = await getAccounts();
  return ctx.reply(`Rostdan o'chirilsinmi?\n${L.txLine(tx, accounts)}`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[
      Markup.button.callback('✅ Ha, o‘chirish', `dy:${tx._id}`),
      Markup.button.callback('↩️ Yo‘q', 'dn'),
    ]]),
  });
});

bot.action('dn', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.deleteMessage().catch(() => {});
});

bot.action(/^dy:([a-f0-9]{24})$/, async (ctx) => {
  const r = await col.tx.findOneAndUpdate(
    { _id: new ObjectId(ctx.match[1]), deletedAt: null },
    { $set: { deletedAt: new Date(), deletedBy: ctx.from.id } },
    { returnDocument: 'after' },
  );
  const tx = r && (r.value !== undefined ? r.value : r);
  if (!tx) return ctx.answerCbQuery('Allaqachon o‘chirilgan');
  await ctx.answerCbQuery('O‘chirildi');
  const [accounts, bal] = await Promise.all([getAccounts(), balance()]);
  const line = L.txLine(tx, accounts);
  await ctx.editMessageText(`🗑 O'chirildi:\n${line}\n\n💰 Kassa: ${L.som(bal)}`, { parse_mode: 'HTML' }).catch(() => {});
  await notifyOthers(ctx, `🗑 ${L.esc(L.displayName(ctx.from))} o'chirdi:\n${line}\n💰 Kassa: <b>${L.som(bal)}</b>`);
});

// ---------- Hisob nomi ----------
bot.command('nom', async (ctx) => {
  const m = /^([1-3])\s+(.{1,20})$/.exec(argsOf(ctx));
  if (!m) return ctx.reply('Format: <code>/nom 1 Ali</code> (nom 20 belgigacha)', { parse_mode: 'HTML' });
  const list = await getAccounts();
  const acc = list.find((a) => a.id === Number(m[1]));
  acc.name = m[2].trim();
  await col.settings.updateOne({ _id: 'accounts' }, { $set: { list } });
  return ctx.reply(`✅ Hisob ${m[1]} nomi: ${acc.name}`);
});

// ---------- Oddiy matn (summa kiritish) ----------
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  const st = state.get(ctx.from.id);
  if (!st) return ctx.reply('Menyudan tanlang 👇', menu);

  const p = L.parseAmountText(text);
  if (!p) return ctx.reply(`❗️ Summani tushunmadim.\n${AMOUNT_HINT}`, { parse_mode: 'HTML' });

  state.delete(ctx.from.id);
  return addTx(ctx, { type: st.type, account: st.account, ...p });
});

bot.catch(async (err, ctx) => {
  console.error('Xatolik:', err);
  try { await ctx.reply('⚠️ Xatolik yuz berdi, qayta urinib ko‘ring.'); } catch (_) { /* ignore */ }
});

// ---------- Ishga tushirish ----------
(async () => {
  await initDb();
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Menyu' },
    { command: 'kirim', description: 'Kirim: /kirim 50000 izoh' },
    { command: 'chiqim', description: 'Chiqim: /chiqim 1 20000 izoh' },
    { command: 'hisobot', description: 'Oylik hisobot' },
    { command: 'nom', description: 'Hisob nomini o‘zgartirish' },
    { command: 'bekor', description: 'Bekor qilish' },
    { command: 'myid', description: 'Telegram ID' },
  ]);
  http.createServer((_, res) => res.end('ok')).listen(process.env.PORT || 3000);
  bot.launch().catch((e) => { console.error(e); process.exit(1); });
  console.log('Kassa boti ishga tushdi');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
