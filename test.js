'use strict';
const assert = require('node:assert');
const L = require('./lib');

// Summa
const eq = (txt, amount, note = '') => {
  const p = L.parseAmountText(txt);
  assert.ok(p, `parse failed: ${txt}`);
  assert.strictEqual(p.amount, amount, txt);
  assert.strictEqual(p.note, note, txt);
};
eq('50000', 50000);
eq('50000 savdo', 50000, 'savdo');
eq('50 000 savdo kuni', 50000, 'savdo kuni');
eq('1 500 000', 1500000);
eq('1.500.000 non', 1500000, 'non');
eq('50k', 50000);
eq('1.5m', 1500000);
eq('2 mln', 2000000);
eq('20000 100 dona', 20000, '100 dona');
assert.strictEqual(L.parseAmountText('salom'), null);
assert.strictEqual(L.parseAmountText('0'), null);
assert.strictEqual(L.parseAmountText(''), null);

// Pul formati
assert.strictEqual(L.money(1234567), '1 234 567');
assert.strictEqual(L.money(-5000), '-5 000');

// Sana: 2026-11-24 14:45 Toshkent = 09:45 UTC
const d = new Date('2026-11-24T09:45:00Z');
assert.strictEqual(L.fmtDT(d), '24.11.2026 14:45');
assert.strictEqual(L.fmtShort(d), '24.11 14:45');
assert.deepStrictEqual(L.currentYM(d), { y: 2026, m: 10 });

// Oy chegaralari (Toshkent vaqti bo'yicha)
const r = L.monthRange({ y: 2026, m: 10 });
assert.strictEqual(r.start.toISOString(), '2026-10-31T19:00:00.000Z');
assert.strictEqual(r.end.toISOString(), '2026-11-30T19:00:00.000Z');
// Oy boshidagi 00:30 (Toshkent) joriy oyga kiradi
assert.ok(new Date('2026-10-31T19:30:00Z') >= r.start);

assert.deepStrictEqual(L.shiftYM({ y: 2026, m: 0 }, -1), { y: 2025, m: 11 });
assert.deepStrictEqual(L.shiftYM({ y: 2026, m: 11 }, 1), { y: 2027, m: 0 });
assert.deepStrictEqual(L.parseYM('2026-10'), { y: 2026, m: 9 });
assert.strictEqual(L.parseYM('2026-13'), null);

// Hisobot
const accounts = [1, 2, 3].map((id) => ({ id, name: `Hisob ${id}` }));
const txs = [
  { type: 'in', amount: 100000, note: 'savdo <b>', userName: 'Olim', createdAt: d },
  { type: 'out', account: 2, amount: 30000, note: '', userName: 'Ali', createdAt: d },
];
const rep = L.buildReport({
  ym: { y: 2026, m: 10 }, accounts, opening: 10000,
  cur: { in: 100000, out: 30000, byAcc: { 1: 0, 2: 30000, 3: 0 } }, txs,
});
assert.ok(rep.summary.includes('Oy oxiriga qoldiq (kassa): <b>80 000 so\'m</b>'), rep.summary);
assert.ok(rep.chunks[0].includes('savdo &lt;b&gt;'), 'HTML escape');
assert.ok(rep.chunks[0].includes('[Hisob 2] <b>-30 000</b>'));

// Chunk
const many = Array.from({ length: 500 }, (_, i) => `qator ${i} `.repeat(5));
const ch = L.chunkLines(many);
assert.ok(ch.length > 1 && ch.every((c) => c.length <= 3600));

// CSV
const csv = L.toCsv(txs, accounts);
assert.ok(csv.startsWith('﻿"Sana";"Vaqt"'));
assert.ok(csv.includes('"24.11.2026";"14:45";"Chiqim";"Hisob 2";"-30000"'));

console.log('Barcha testlar o‘tdi ✅');
