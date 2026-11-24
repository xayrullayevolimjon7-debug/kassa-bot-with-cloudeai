try { require('dotenv').config(); } catch (_) { /* dotenv ixtiyoriy */ }
const { Telegraf, Markup } = require('telegraf');
const { MongoClient, ObjectId } = require('mongodb');
const L = require('./lib');

const { BOT_TOKEN, MONGODB_URI, ACCESS_CODE } = process.env;
if (!BOT_TOKEN || !MONGODB_URI || !ACCESS_CODE) {
  throw new Error('BOT_TOKEN, MONGODB_URI va ACCESS_CODE muhit o\'zgaruvchilari kerak');
}

const MAX_USERS = 3;
const bot = new Telegraf(BOT_TOKEN);

// ---------- MongoDB (serverless uchun keshlanadi) ----------
let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const client = new MongoClient(MONGODB_URI);
      await client.connect();
      const d = client.db(process.env.DB_NAME || 'kassa');
      await d.collection('tx').createIndex({ at: 1 });
      return d;
    })().catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

const DEFAULT_NAMES = ['Hisob 1', 'Hisob 2', 'Hisob 3'];
async function getNames() {
  const d = await db();
  const c = await d.collection('config').findOne({ _id: 'main' });
  return c?.names || DEFAULT_NAMES;
}

async function setState(ctx, state) {
  const d = await db();
  await d.collection('users').updateOne({ _id: ctx.from.id }, { $set: { state } });
  ctx.state.user.state = state;
}

async function totals(match) {
  const d = await db();
  const rows = await d
    .collection('tx')
    .aggregate([{ $match: match }, { $group: { _id: '$type', sum: { $sum: '$amount' } } }])
    .toArray();
  const get = (t) => rows.find((r) => r._id === t)?.sum || 0;
  return { in: get('in'), out: get('out') };
}

async function balance() {
  const t = await totals({});
  return t.in - t.out;
}

async function notifyOthers(ctx, html) {
  const d = await db();
  const others = await d.collection('users').find({ _id: { $ne: ctx.from.id } }).toArray();
  await Promise.allSettled(
    others.map((o) => ctx.telegram.sendMessage(o._id, html, { parse_mode: 'HTML' }))
  );
}

// ---------- Menyu ----------
const BTN = {
  IN: '➕ Kirim',
  OUT: '➖ Chiqim',
  REPORT: '📊 Hisobot',
  LAST: '📜 Oxirgilar',
  CASH: '💰 Kassa',
  SET: '⚙️ Sozlamalar',
};
const menu = Markup.keyboard([
  [BTN.IN, BTN.OUT],
  [BTN.REPORT, BTN.LAST],
  [BTN.CASH, BTN.SET],
]).resize();

const HELP =
  '<b>Tez kiritish:</b>\n' +
  '<code>+150000 savdo</code> — kassaga kirim\n' +
  '<code>-20000 2 benzin</code> — 2-hisobdan chiqim\n' +
  '<code>-20000 benzin</code> — hisobni tugmadan tanlaysiz\n' +
  'Summa: <code>150000</code>, <code>150.000</code>, <code>150k</code>, <code>1.5m</code>\n\n' +
  '/bekor — joriy amalni bekor qilish';

// ---------- Ruxsat (faqat 3 ta foydalanuvchi) ----------
bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.chat?.type !== 'private') return;
  const d = await db();
  const user = await d.collection('users').findOne({ _id: ctx.from.id });
  const text = ctx.message?.text || '';

  if (!user) {
    if (/^\/start/.test(text)) {
      const code = text.split(/\s+/)[1];
      const count = await d.collection('users').countDocuments();
      if (code && code === ACCESS_CODE && count < MAX_USERS) {
        const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
        await d.collection('users').insertOne({
          _id: ctx.from.id,
          name: name || String(ctx.from.id),
          joinedAt: new Date(),
          state: null,
        });
        return ctx.reply(
          `✅ Xush kelibsiz, ${name}! Siz kassa foydalanuvchisi sifatida qo'shildingiz ` +
            `(${count + 1}/${MAX_USERS}).\n\n${HELP}`,
          { parse_mode: 'HTML', ...menu }
        );
      }
      if (code === ACCESS_CODE && count >= MAX_USERS) {
        return ctx.reply(`⛔ Foydalanuvchilar to'lgan (${MAX_USERS}/${MAX_USERS}).`);
      }
    }
    if (ctx.callbackQuery) return ctx.answerCbQuery('⛔ Ruxsat yo\'q');
    return ctx.reply('⛔ Ruxsat yo\'q. Kirish uchun: /start KOD');
  }

  ctx.state.user = user;
  return next();
});

// ---------- Amal qo'shish ----------
async function addTx(ctx, { type, account, amount, note }) {
  const d = await db();
  const u = ctx.state.user;
  const names = await getNames();
  await d.collection('tx').insertOne({
    type,
    account: type === 'out' ? account : null,
    amount,
    note: note || '',
    by: u._id,
    byName: u.name,
    at: new Date(),
  });
  await setState(ctx, null);
  const bal = await balance();

  const line =
    type === 'in'
      ? `➕ Kirim: <b>${L.money(amount)}</b> → Kassa`
      : `➖ Chiqim: <b>${L.money(amount)}</b> ← ${L.esc(names[account - 1])}`;
  const tail = (note ? `\n📝 ${L.esc(note)}` : '') + `\n🏦 Kassa: <b>${L.money(bal)}</b>`;

  await ctx.reply(`✅ Saqlandi\n${line}${tail}`, { parse_mode: 'HTML', ...menu });
  await notifyOthers(ctx, `👤 <b>${L.esc(u.name)}</b>\n${line}${tail}`);
}

function accountButtons(names, prefix = 'pick') {
  return Markup.inlineKeyboard(
    names.map((n, i) => Markup.button.callback(`👤 ${n}`, `${prefix}:${i + 1}`)),
    { columns: 1 }
  );
}

// ---------- Buyruqlar va menyu ----------
bot.start((ctx) =>
  ctx.reply('Asosiy menyu 👇\n\n' + HELP, { parse_mode: 'HTML', ...menu })
);
bot.help((ctx) => ctx.reply(HELP, { parse_mode: 'HTML', ...menu }));
bot.command('bekor', async (ctx) => {
  await setState(ctx, null);
  ctx.reply('❌ Bekor qilindi.', menu);
});
bot.command('hisobot', (ctx) => sendReport(ctx, 0));

bot.hears(BTN.IN, async (ctx) => {
  await setState(ctx, { t: 'in' });
  ctx.reply(
    '➕ <b>Kirim</b> summasini yozing (izoh bilan ham bo\'ladi):\n<code>150000 savdo</code>',
    { parse_mode: 'HTML' }
  );
});

bot.hears(BTN.OUT, async (ctx) => {
  await setState(ctx, null);
  const names = await getNames();
  ctx.reply('➖ <b>Chiqim</b> qaysi hisobdan?', {
    parse_mode: 'HTML',
    ...accountButtons(names),
  });
});

bot.hears(BTN.CASH, async (ctx) => {
  await setState(ctx, null);
  const names = await getNames();
  const { from, to, label } = L.monthRange(0);
  const d = await db();
  const bal = await balance();
  const per = await d
    .collection('tx')
    .aggregate([
      { $match: { type: 'out', at: { $gte: from, $lt: to } } },
      { $group: { _id: '$account', sum: { $sum: '$amount' } } },
    ])
    .toArray();
  const inM = (await totals({ type: 'in', at: { $gte: from, $lt: to } })).in;
  const lines = names.map(
    (n, i) => `   • ${L.esc(n)}: ${L.money(per.find((p) => p._id === i + 1)?.sum || 0)}`
  );
  ctx.reply(
    `🏦 <b>Kassa hozir:</b> ${L.money(bal)}\n\n` +
      `📆 ${label}\n➕ Kirim: ${L.money(inM)}\n➖ Chiqimlar:\n${lines.join('\n')}`,
    { parse_mode: 'HTML' }
  );
});

bot.hears(BTN.REPORT, async (ctx) => {
  await setState(ctx, null);
  ctx.reply('Qaysi oy?', Markup.inlineKeyboard([
    [Markup.button.callback('📊 Shu oy', 'rep:0'), Markup.button.callback('📆 O\'tgan oy', 'rep:1')],
    [Markup.button.callback('2 oy oldin', 'rep:2'), Markup.button.callback('3 oy oldin', 'rep:3')],
  ]));
});

bot.hears(BTN.LAST, async (ctx) => {
  await setState(ctx, null);
  const d = await db();
  const names = await getNames();
  const rows = await d.collection('tx').find().sort({ at: -1 }).limit(10).toArray();
  if (!rows.length) return ctx.reply('Hali amallar yo\'q.');
  const lines = rows.map((r, i) => txLine(r, names, i + 1));
  const kb = Markup.inlineKeyboard(
    rows.map((r, i) => Markup.button.callback(`🗑 ${i + 1}`, `del:${r._id}`)),
    { columns: 5 }
  );
  ctx.reply(`📜 <b>Oxirgi 10 ta amal</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML', ...kb });
});

bot.hears(BTN.SET, async (ctx) => {
  await setState(ctx, null);
  const d = await db();
  const names = await getNames();
  const users = await d.collection('users').find().toArray();
  ctx.reply(
    `⚙️ <b>Hisoblar:</b>\n${names.map((n, i) => `${i + 1}. ${L.esc(n)}`).join('\n')}\n\n` +
      `👥 <b>Foydalanuvchilar (${users.length}/${MAX_USERS}):</b>\n` +
      users.map((u) => `• ${L.esc(u.name)}`).join('\n'),
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(
        names.map((n, i) => Markup.button.callback(`✏️ "${n}" nomini o'zgartirish`, `ren:${i + 1}`)),
        { columns: 1 }
      ),
    }
  );
});

// ---------- Ro'yxat / hisobot ----------
function txLine(r, names, n) {
  const when = L.fmtShort(r.at);
  const who = L.esc(r.byName);
  const note = r.note ? ` — ${L.esc(r.note)}` : '';
  const num = n ? `${n}. ` : '';
  return r.type === 'in'
    ? `${num}${when} ➕ ${L.fmt(r.amount)} (Kassa)${note} · ${who}`
    : `${num}${when} ➖ ${L.fmt(r.amount)} [${L.esc(names[r.account - 1])}]${note} · ${who}`;
}

async function sendReport(ctx, offset) {
  const d = await db();
  const names = await getNames();
  const { from, to, label } = L.monthRange(offset);

  const rows = await d
    .collection('tx')
    .find({ at: { $gte: from, $lt: to } })
    .sort({ at: 1 })
    .toArray();
  const before = await totals({ at: { $lt: from } });
  const opening = before.in - before.out;

  const sumIn = rows.filter((r) => r.type === 'in').reduce((s, r) => s + r.amount, 0);
  const cntIn = rows.filter((r) => r.type === 'in').length;
  const outRows = rows.filter((r) => r.type === 'out');
  const sumOut = outRows.reduce((s, r) => s + r.amount, 0);
  const perAcc = names.map((n, i) => {
    const rs = outRows.filter((r) => r.account === i + 1);
    return { name: n, sum: rs.reduce((s, r) => s + r.amount, 0), cnt: rs.length };
  });
  const closing = opening + sumIn - sumOut;

  const summary = [
    `📊 <b>${label} — oylik hisobot</b>`,
    '',
    `🏦 Oy boshida kassa: ${L.money(opening)}`,
    `➕ Kirim: <b>${L.money(sumIn)}</b> (${cntIn} ta)`,
    `➖ Chiqim jami: <b>${L.money(sumOut)}</b> (${outRows.length} ta)`,
    ...perAcc.map((a) => `    • ${L.esc(a.name)}: ${L.money(a.sum)} (${a.cnt} ta)`),
    `🏦 Oy oxirida kassa: <b>${L.money(closing)}</b>`,
  ];

  const opLines = rows.length
    ? ['', '📜 <b>Barcha amallar:</b>', ...rows.map((r) => txLine(r, names))]
    : ['', 'Bu oyda amallar yo\'q.'];

  const chunks = L.chunkLines([...summary, ...opLines]);
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    await ctx.reply(chunks[i], {
      parse_mode: 'HTML',
      ...(last && rows.length
        ? Markup.inlineKeyboard([Markup.button.callback('📥 CSV (Excel) yuklab olish', `csv:${offset}`)])
        : {}),
    });
  }
}

// ---------- Inline tugmalar ----------
bot.action(/^rep:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await sendReport(ctx, Number(ctx.match[1]));
});

bot.action(/^csv:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const d = await db();
  const names = await getNames();
  const { from, to, label } = L.monthRange(Number(ctx.match[1]));
  const rows = await d.collection('tx').find({ at: { $gte: from, $lt: to } }).sort({ at: 1 }).toArray();
  const csv = L.toCsv(rows, names);
  await ctx.replyWithDocument({
    source: Buffer.from(csv, 'utf8'),
    filename: `kassa_${label.replace(' ', '_')}.csv`,
  });
});

// Hisob tanlash (menyudan yoki tez kiritishdan keyin)
bot.action(/^pick:([1-3])$/, async (ctx) => {
  const acc = Number(ctx.match[1]);
  const names = await getNames();
  const st = ctx.state.user.state;
  await ctx.answerCbQuery();
  if (st?.t === 'out_pick') {
    await ctx.editMessageText(`Tanlandi: ${names[acc - 1]}`);
    return addTx(ctx, { type: 'out', account: acc, amount: st.amount, note: st.note });
  }
  await setState(ctx, { t: 'out', acc });
  await ctx.editMessageText(
    `➖ <b>${L.esc(names[acc - 1])}</b> hisobidan chiqim summasini yozing:\n<code>20000 benzin</code>`,
    { parse_mode: 'HTML' }
  );
});

// O'chirish (tasdiq bilan)
bot.action(/^del:([a-f0-9]{24})$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'Bu amalni o\'chirishni tasdiqlaysizmi?',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Ha, o\'chirish', `delok:${ctx.match[1]}`),
        Markup.button.callback('Yo\'q', 'cancel'),
      ],
    ])
  );
});
bot.action(/^delok:([a-f0-9]{24})$/, async (ctx) => {
  const d = await db();
  const names = await getNames();
  const r = await d.collection('tx').findOneAndDelete({ _id: new ObjectId(ctx.match[1]) });
  await ctx.answerCbQuery();
  if (!r) return ctx.editMessageText('Bu amal allaqachon o\'chirilgan.');
  await ctx.editMessageText('🗑 O\'chirildi.');
  await notifyOthers(
    ctx,
    `🗑 <b>${L.esc(ctx.state.user.name)}</b> amalni o'chirdi:\n${txLine(r, names)}\n` +
      `🏦 Kassa: <b>${L.money(await balance())}</b>`
  );
});
bot.action('cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Bekor qilindi.');
});

// Hisob nomini o'zgartirish
bot.action(/^ren:([1-3])$/, async (ctx) => {
  await ctx.answerCbQuery();
  await setState(ctx, { t: 'rename', acc: Number(ctx.match[1]) });
  await ctx.reply(`${ctx.match[1]}-hisob uchun yangi nomni yozing (masalan: Ali):`);
});

// ---------- Oddiy matn ----------
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  const st = ctx.state.user.state;

  if (st?.t === 'rename') {
    const name = text.slice(0, 30);
    const names = [...(await getNames())];
    names[st.acc - 1] = name;
    const d = await db();
    await d.collection('config').updateOne({ _id: 'main' }, { $set: { names } }, { upsert: true });
    await setState(ctx, null);
    return ctx.reply(`✅ ${st.acc}-hisob nomi: ${name}`, menu);
  }

  if (st?.t === 'in') {
    const e = parseOrFail(ctx, text, false);
    return e && addTx(ctx, { type: 'in', ...e });
  }
  if (st?.t === 'out') {
    const e = parseOrFail(ctx, text, false);
    return e && addTx(ctx, { type: 'out', account: st.acc, amount: e.amount, note: e.note });
  }

  // Tez kiritish: +summa izoh | -summa [hisob] izoh
  if (/^[+-]/.test(text)) {
    const isIn = text[0] === '+';
    const e = L.parseEntry(text, !isIn);
    if (!e) return ctx.reply('❗ Summani tushunmadim. Masalan: +150000 savdo yoki -20000 2 benzin');
    if (isIn) return addTx(ctx, { type: 'in', amount: e.amount, note: e.note });
    if (e.account) return addTx(ctx, { type: 'out', account: e.account, amount: e.amount, note: e.note });
    await setState(ctx, { t: 'out_pick', amount: e.amount, note: e.note });
    const names = await getNames();
    return ctx.reply(`➖ ${L.money(e.amount)} qaysi hisobdan?`, accountButtons(names));
  }

  ctx.reply('Menyudan foydalaning 👇\n\n' + HELP, { parse_mode: 'HTML', ...menu });
});

function parseOrFail(ctx, text, wantAcc) {
  const e = L.parseEntry(text, wantAcc);
  if (!e) ctx.reply('❗ Summani tushunmadim. Faqat raqam yozing, masalan: 150000 savdo');
  return e;
}

bot.catch((err, ctx) => {
  console.error('Xato:', err);
  ctx.reply?.('⚠️ Xatolik yuz berdi, qayta urinib ko\'ring.').catch(() => {});
});

module.exports = { bot };
