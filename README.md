# Kassa boti (Telegram)

Kassadagi pul kirim-chiqimini hisoblash boti. 3 ta hisob, foydalanuvchilar soni cheklanmagan.

## Qanday ishlaydi
- **Kirim** — hammasi bitta umumiy kassaga yoziladi.
- **Chiqim** — 3 ta hisobdan (Hisob 1/2/3) biriga yoziladi. Nomini `/nom 1 Ali` bilan o'zgartirasiz.
- **Kassa qoldig'i** = barcha kirim − barcha chiqim.
- Parolni bilgan har bir foydalanuvchi kirim, 3 ta hisobning chiqimlari va o'chirishni boshqara oladi.
- Har amal sana va soat (Toshkent vaqti) bilan saqlanadi, kim kiritgani ham yoziladi.
- `NOTIFY=1` bo'lsa, biri amal qo'shganda boshqa a'zolarga xabar boradi.
- O'chirilgan amallar bazadan o'chmaydi, faqat belgilanadi.

## O'rnatish
1. **@BotFather** → `/newbot` → tokenni oling.
2. **MongoDB Atlas** da (bepul klaster) ulanish manzilini oling (`MONGODB_URI`).
3. `.env.example` ni `.env` ga ko'chirib to'ldiring. `ACCESS_CODE` — parol: botga shu so'zni yozgan kishi a'zo bo'ladi.
4. Lokal: `npm install && npm start`

## Railway'ga joylash
Loyihani GitHub'ga yuklang → Railway → New Project → Deploy from repo.
Variables bo'limiga `BOT_TOKEN`, `MONGODB_URI`, `DB_NAME`, `ACCESS_CODE` ni kiriting. Atlas'da Network Access → `0.0.0.0/0` ruxsat bering. Start buyrug'i: `npm start`.
(Bot long polling bilan ishlaydi, doimiy ishlaydigan server kerak — Vercel serverless'ga mos emas.)

## Buyruqlar
| Menyu / buyruq | Vazifasi |
|---|---|
| ➕ Kirim · `/kirim 50000 izoh` | Kassaga kirim |
| ➖ Chiqim · `/chiqim 1 20000 izoh` | Hisobdan chiqim |
| 💰 Kassa | Joriy qoldiq va shu oy |
| 📊 Oylik hisobot · `/hisobot 2026-10` | Oy bo'yicha hamma amal, oldingi/keyingi oy, CSV |
| 🕘 Oxirgilar | Oxirgi 10 amal, o'chirish |
| `/nom 1 Ali` | Hisob nomi |
| `/bekor`, `/myid` | Bekor qilish, ID |

Summa formatlari: `50000`, `50 000`, `1.500.000`, `50k`, `1.5m`, `2 mln`.

`npm test` — hisob-kitob funksiyalari testlari.
