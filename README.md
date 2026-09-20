# simple-trade-bot

Bot auto-order **Spot & Futures** yang ringan (Node.js >= 18, tanpa TypeScript, bundler, atau native module). Order dipicu lewat **webhook TradingView**.

## Fitur

- Auto order **Spot** (buy/sell, market atau limit) dan **Futures** (long/short, close reduce-only, set leverage & margin mode).
- Menerima sinyal dari **TradingView alert** via HTTP webhook.
- Multi-profile/exchange lewat CCXT.
- Tanpa dependency native, jadi aman dari masalah compile/glibc.

## Instalasi

```bash
npm install
cp config.example.json config.json
cp .env.example .env
# isi .env (API key/secret) dan sesuaikan config.json
```

## Menjalankan webhook

```bash
npm start
# atau
node src/index.js serve
```

Endpoint:
- `GET /dashboard` — dashboard web (status + order manual)
- `POST /webhook` — terima sinyal
- `GET /health` — cek server hidup

## Dashboard

Buka `http://localhost:8787/dashboard` (atau `/`). Isi **Webhook secret** di halaman (harus sama dengan `WEBHOOK_SECRET`), lalu:
- **Muat saldo** — saldo spot/futures per profile.
- **Muat posisi** — posisi futures terbuka.
- **Order manual** — form buy/sell/close tanpa perlu TradingView.

Dashboard memanggil API internal (`/api/meta`, `/api/balance`, `/api/positions`, `/api/order`) yang semuanya butuh secret (`x-webhook-secret`). Tanpa secret, data tidak bisa diakses.

## Format alert TradingView

Isi "Message" pada alert (pilih opsi JSON bila perlu), contoh:

```json
{
  "secret": "{{secret}}",
  "profile": "binance1",
  "market": "future",
  "ticker": "BTCUSDT",
  "action": "long",
  "amount": 50,
  "amountType": "quote"
}
```

Field:
- `secret` — harus sama dengan `webhook.secret` (atau header `x-webhook-secret`).
- `profile` — opsional, default `defaultProfile`.
- `market` — `spot` atau `future`.
- `ticker` — key di `symbolMap` (mis. `BTCUSDT`), atau simbol CCXT langsung (`BTC/USDT:USDT`).
- `action` — `long`/`buy`, `short`/`sell`, atau `close`.
- `amount` — angka. Default dihitung sebagai **quote** (mis. USDT) untuk long/short; `amountType: "base"` untuk jumlah koin.
- `price` — opsional; jika diisi, order dikirim sebagai **limit**, kalau tidak **market**.

Untuk close: cukup `{"action":"close"}`.
- Spot: menjual seluruh saldo base yang tersedia.
- Futures: menutup posisi terbuka dengan `reduceOnly`.

## CLI

```bash
node src/index.js balance binance1 spot
node src/index.js positions binance1
node src/index.js order --profile=binance1 --market=spot --symbol=BTCUSDT --action=long --amount=100
node src/index.js order --profile=binance1 --market=future --symbol=BTCUSDT --action=short --amount=50 --amount-type=quote
node src/index.js order --profile=binance1 --market=future --symbol=BTC/USDT:USDT --action=close
```

## Konfigurasi

`config.json`:
- `server` — host/port webhook.
- `webhook.secret` — secret validasi (bisa `env:NAMA_ENV`).
- `webhook.ipAllowlist` — opsional; batasi IP pengirim. Kosong = semua diizinkan.
- `defaultProfile` — profile default bila payload tidak menyebut `profile`.
- `profiles[]` — `id`, `exchange` (id CCXT), `apiKey`/`secret` (bisa `env:...`), `leverage`, `marginMode`, `allowSpot`, `allowFutures`.
- `symbolMap` — pemetaan ticker TradingView ke simbol CCXT spot & futures.

Nilai yang diawali `env:` akan dibaca dari environment variable, jadi API key tidak perlu ditulis di file.

## Keamanan

- Selalu set `webhook.secret`.
- Webhook default listen di `0.0.0.0`; batasi `server.host` atau gunakan reverse proxy + HTTPS.
- API key sebaiknya hanya izinkan trading, **tanpa** izin withdraw.

## Catatan

- Order long/short futures memakai market order (kecuali `price` diisi).
- `setLeverage` / `setMarginMode` diabaikan jika exchange tidak mendukung.
- Perhitungan amount memakai presisi exchange (`amountToPrecision`).
