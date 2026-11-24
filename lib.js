'use strict';

// O'zbekiston (Asia/Tashkent) = UTC+5, yozgi/qishki vaqt yo'q.
const TZ_OFFSET_MS = 5 * 60 * 60 * 1000;

const MONTHS = [
  'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
  'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr',
];

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const pad = (n) => String(n).padStart(2, '0');

function money(n) {
  const neg = n < 0;
  const s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + s;
}

const som = (n) => `${money(n)} so'm`;

// ---------- Sana / vaqt ----------
const local = (d) => new Date(new Date(d).getTime() + TZ_OFFSET_MS);

function fmtDT(d) {
  const l = local(d);
  return `${pad(l.getUTCDate())}.${pad(l.getUTCMonth() + 1)}.${l.getUTCFullYear()} ${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}`;
}

function fmtShort(d) {
  const l = local(d);
  return `${pad(l.getUTCDate())}.${pad(l.getUTCMonth() + 1)} ${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}`;
}

function currentYM(now = new Date()) {
  const l = local(now);
  return { y: l.getUTCFullYear(), m: l.getUTCMonth() };
}

function shiftYM(ym, delta) {
  const idx = ym.y * 12 + ym.m + delta;
  return { y: Math.floor(idx / 12), m: ((idx % 12) + 12) % 12 };
}

const ymKey = (ym) => `${ym.y}-${pad(ym.m + 1)}`;

function parseYM(s) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const mon = Number(m[2]) - 1;
  if (mon < 0 || mon > 11) return null;
  return { y: Number(m[1]), m: mon };
}

// Oyning boshlanishi/oxiri (UTC Date ko'rinishida, Toshkent vaqti bo'yicha)
function monthRange(ym) {
  return {
    start: new Date(Date.UTC(ym.y, ym.m, 1) - TZ_OFFSET_MS),
    end: new Date(Date.UTC(ym.y, ym.m + 1, 1) - TZ_OFFSET_MS),
  };
}

// ---------- Summani o'qish ----------
// "50000 savdo", "50 000 savdo", "1.500.000", "50k", "1.5m", "2 mln non"
function parseAmountText(text) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  let first = tokens[0].toLowerCase();
  let used = 1;

  // "50 000" / "1 500 000" -> bo'shliq bilan ajratilgan guruhlar
  if (/^\d{1,3}$/.test(first)) {
    while (used < tokens.length && /^\d{3}$/.test(tokens[used])) {
      first += tokens[used];
      used++;
    }
  }

  // "2 mln", "50 k" -> qo'shimcha so'z sifatida ajratilgan qo'shimcha
  if (used < tokens.length && /^(k|ming|m|mln)$/i.test(tokens[used])) {
    first += tokens[used].toLowerCase();
    used++;
  }

  let amount;
  if (/^\d{1,3}([.,]\d{3})+$/.test(first)) {
    amount = parseInt(first.replace(/[.,]/g, ''), 10); // 1.500.000
  } else {
    const m = /^(\d+(?:[.,]\d+)?)(k|ming|m|mln)?$/.exec(first);
    if (!m) return null;
    const num = parseFloat(m[1].replace(',', '.'));
    const mult = !m[2] ? 1 : m[2] === 'k' || m[2] === 'ming' ? 1e3 : 1e6;
    amount = Math.round(num * mult);
  }

  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e13) return null;
  return { amount, note: tokens.slice(used).join(' ').slice(0, 200) };
}

// ---------- Ko'rinish ----------
const displayName = (u) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id);

function accName(accounts, id) {
  const a = accounts.find((x) => x.id === id);
  return a ? a.name : `Hisob ${id}`;
}

function txLine(tx, accounts) {
  const when = fmtShort(tx.createdAt);
  const note = tx.note ? ` — ${esc(tx.note)}` : '';
  const who = ` · ${esc(tx.userName)}`;
  if (tx.type === 'in') {
    return `${when} ➕ <b>${money(tx.amount)}</b>${note}${who}`;
  }
  return `${when} ➖ [${esc(accName(accounts, tx.account))}] <b>-${money(tx.amount)}</b>${note}${who}`;
}

function chunkLines(lines, max = 3500) {
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > max) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function buildReport({ ym, accounts, opening, cur, txs }) {
  const closing = opening + cur.in - cur.out;
  let s = `📊 <b>${MONTHS[ym.m]} ${ym.y} — oylik hisobot</b>\n\n`;
  s += `🏦 Oy boshiga qoldiq: <b>${som(opening)}</b>\n`;
  s += `➕ Kirim (umumiy kassaga): <b>${som(cur.in)}</b>\n`;
  s += `➖ Chiqim jami: <b>${som(-cur.out)}</b>\n`;
  for (const a of accounts) {
    s += `     👤 ${esc(a.name)}: ${som(-(cur.byAcc[a.id] || 0))}\n`;
  }
  s += `\n💰 Oy oxiriga qoldiq (kassa): <b>${som(closing)}</b>`;

  if (!txs.length) {
    s += `\n\nBu oyda amallar yo'q.`;
    return { summary: s, chunks: [] };
  }
  const lines = ['🧾 <b>Barcha amallar:</b>', ...txs.map((t) => txLine(t, accounts))];
  return { summary: s, chunks: chunkLines(lines) };
}

function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

function toCsv(txs, accounts) {
  const rows = [['Sana', 'Vaqt', 'Turi', 'Hisob', 'Summa', 'Izoh', 'Kim']];
  for (const t of txs) {
    const dt = fmtDT(t.createdAt).split(' ');
    rows.push([
      dt[0],
      dt[1],
      t.type === 'in' ? 'Kirim' : 'Chiqim',
      t.type === 'in' ? 'Kassa' : accName(accounts, t.account),
      t.type === 'in' ? t.amount : -t.amount,
      t.note,
      t.userName,
    ]);
  }
  // BOM — Excel'da UTF-8 to'g'ri ochilishi uchun
  return '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
}

module.exports = {
  TZ_OFFSET_MS, MONTHS, esc, money, som, fmtDT, fmtShort, currentYM, shiftYM, ymKey,
  parseYM, monthRange, parseAmountText, displayName, accName, txLine, chunkLines,
  buildReport, toCsv,
};
