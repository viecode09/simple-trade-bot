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

## Strategi MA (7/25/99)

Bot bisa auto-trading dari data candle exchange (bukan TradingView) memakai MA cross + filter tren:

- **Long**: MA7 cross ke atas MA25 **dan** harga > MA99.
- **Short**: MA7 cross ke bawah MA25 **dan** harga < MA99.
- Posisi berlawanan ditutup dulu (`close`) lalu buka arah baru.
- Sinyal dihitung dari candle yang **sudah closed** (anti-repaint).

```bash
# cek sinyal sekali (dry-run, tidak order)
node src/index.js strategy --profile=binance1 --market=future --symbol=BTCUSDT --amount=50 --timeframe=15m --dry-run

# eksekusi sekali
node src/index.js strategy --profile=binance1 --market=future --symbol=BTCUSDT --amount=50 --timeframe=15m

# pantau terus (polling, order hanya saat cross candle baru)
node src/index.js strategy --profile=binance1 --market=future --symbol=BTCUSDT --amount=50 --timeframe=15m --watch --interval=30
```

Opsi: `--fast=7`, `--slow=25`, `--trend=99`, `--amount-type=quote|base`, `--dry-run`, `--watch`, `--interval` (detik).

## Konfigurasi

`config.json`:
- `server` — host/port webhook.
- `webhook.secret` — secret validasi (bisa `env:NAMA_ENV`).
- `webhook.ipAllowlist` — opsional; batasi IP pengirim. Kosong = semua diizinkan.
- `defaultProfile` — profile default bila payload tidak menyebut `profile`.
- `profiles[]` — `id`, `exchange` (id CCXT), `apiKey`/`secret` (bisa `env:...`), `leverage`, `marginMode`, `allowSpot`, `allowFutures`.
- `symbolMap` — pemetaan ticker TradingView ke simbol CCXT spot & futures.

Nilai yang diawali `env:` akan dibaca dari environment variable, jadi API key tidak perlu ditulis di file.

## Hosting di Ubuntu (systemd)

Jalankan bot sebagai service yang auto-start saat boot dan auto-restart saat crash.

```bash
# 1. Prasyarat
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Ambil kode & dependency
sudo mkdir -p /opt/simple-trade-bot && sudo chown "$USER":"$USER" /opt/simple-trade-bot
git clone https://github.com/viecode09/simple-trade-bot.git /opt/simple-trade-bot
cd /opt/simple-trade-bot
npm install

# 3. Konfigurasi
cp config.example.json config.json
cp .env.example .env
nano .env          # isi BINANCE_API_KEY, BINANCE_SECRET, WEBHOOK_SECRET
nano config.json   # sesuaikan profile & symbolMap bila perlu

# 4. Pasang service systemd
sudo bash deploy/install.sh
```

`deploy/install.sh` menulis `/etc/systemd/system/simple-trade-bot.service` (User, Node, dan path terisi otomatis), lalu `enable --now`.

Perintah operasional:

```bash
systemctl status simple-trade-bot     # cek status
journalctl -u simple-trade-bot -f      # lihat log realtime
systemctl restart simple-trade-bot     # restart
systemctl stop simple-trade-bot        # stop
```

Catatan:

- Jika Node dipasang lewat **nvm**, `sudo` tidak melihat PATH nvm. Pakai Node dari apt (langkah di atas) atau isi `ExecStart` manual dengan path node nvm.
- Jalankan strategi MA `--watch` sebagai service terpisah: salin unit, ganti `ExecStart` menjadi `... src/index.js strategy --profile=binance1 --market=future --symbol=BTCUSDT --amount=50 --watch`, dan ubah `Description`.
- Server webhook (port 8787) sebaiknya hanya diakses lewat reverse proxy (Nginx) + HTTPS, bukan dibuka langsung ke publik.

## Keamanan

- Selalu set `webhook.secret`.
- Webhook default listen di `0.0.0.0`; batasi `server.host` atau gunakan reverse proxy + HTTPS.
- API key sebaiknya hanya izinkan trading, **tanpa** izin withdraw.

## Catatan

- Order long/short futures memakai market order (kecuali `price` diisi).
- `setLeverage` / `setMarginMode` diabaikan jika exchange tidak mendukung.
- Perhitungan amount memakai presisi exchange (`amountToPrecision`).
