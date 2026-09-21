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
- **Saldo Binance (live)** — streaming saldo spot/futures via SSE, refresh otomatis tiap N detik.
- **Open posisi futures (live)** — kartu terpisah dengan Profile sendiri, streaming posisi terbuka (PnL, entry, mark, leverage) plus aksi per posisi:
  - **Close** — menutup posisi (reduce-only).
  - **Stop** — memasang stop market reduce-only; masukkan harga trigger saat diminta.
- **Order manual** — digabung dalam kartu yang sama dengan Open Posisi: form buy/sell/close/stop tanpa perlu TradingView. Action `stop` memakai field **Stop price**.
- **Chart** — candlestick dengan overlay MA fast/slow/trend (default 7/25/99), marker sinyal `L`/`S`, dan marker `DIP` (aktifkan checkbox **dip_catcher**), sumber candle dari exchange (ccxt).
- **Analisa MA** — sinyal (long/short/none), harga, nilai MA, status cross, alasan, dan posisi saat ini.
- **Rekomendasi aksi (trend market)** — analisa multi-timeframe (5m/15m/1h/4h/1d) memakai MA fast/slow/trend, menampilkan klasifikasi tren tiap timeframe (`Bullish kuat`/`Bullish`/`Bearish`/`Netral`) dan rekomendasi akhir `BUY`/`SELL` (spot) atau `LONG`/`SHORT` (future), plus `HOLD` bila netral.
- **Tambah pair** — input di card Rekomendasi untuk menambah ticker pair (mis. `ADAUSDT` atau `ADA/USDT`) yang langsung bisa dicek/dianalisa (chart & trend). Tersimpan di `watchlist.json`; pair diturunkan otomatis ke simbol spot & futures.

Endpoint internal (semua butuh secret):
- `GET /api/meta` — daftar profile, ticker, timeframe, default MA.
- `GET /api/tickers` — daftar pair tambahan di watchlist.
- `POST /api/tickers` — tambah pair. Body: `{"ticker":"ADAUSDT","profile":"binance1","market":"spot"}` (opsional `symbol`/`futureSymbol` untuk override).
- `DELETE /api/tickers?ticker=ADAUSDT` — hapus pair dari watchlist.
- `GET /api/balance?profile=&market=` — saldo.
- `GET /api/positions?profile=` — posisi futures.
- `GET /api/candles?profile=&market=&symbol=&timeframe=&fast=&slow=&trend=&limit=` — candle + MA + marker + analisa.
- `GET /api/trends?profile=&market=&symbol=&timeframes=&fast=&slow=&trend=` — trend multi-timeframe + rekomendasi aksi. `timeframes` opsional (default `5m,15m,1h,4h,1d`).
- `GET /api/stream?secret=&profile=&market=&interval=&scope=` — Server-Sent Events saldo & posisi. `scope` = `balance`/`positions`/`both` (default `both`).
- `POST /api/order` — order (sama seperti `/webhook`).

Secret dikirim lewat header `x-webhook-secret`; khusus SSE lewat query `secret` karena `EventSource` tidak bisa mengirim header (gunakan HTTPS saat diekspos).

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
- `action` — `long`/`buy`, `short`/`sell`, `close`, atau `stop`.
- `amount` — angka. Default dihitung sebagai **quote** (mis. USDT) untuk long/short; `amountType: "base"` untuk jumlah koin. Untuk `stop`, opsional (default seluruh contracts posisi).
- `price` — opsional; jika diisi, order dikirim sebagai **limit**, kalau tidak **market**.
- `stopPrice` — wajib untuk `action: "stop"` (harga trigger stop market futures, reduce-only).

Untuk close: cukup `{"action":"close"}`.
- Spot: menjual seluruh saldo base yang tersedia.
- Futures: menutup posisi terbuka dengan `reduceOnly`.

Untuk stop (futures saja): `{"action":"stop","stopPrice":60000}` — memasang stop market reduce-only pada posisi yang ada.

## CLI

```bash
node src/index.js balance binance1 spot
node src/index.js positions binance1
node src/index.js order --profile=binance1 --market=spot --symbol=BTCUSDT --action=long --amount=100
node src/index.js order --profile=binance1 --market=future --symbol=BTCUSDT --action=short --amount=50 --amount-type=quote
node src/index.js order --profile=binance1 --market=future --symbol=BTC/USDT:USDT --action=close
node src/index.js order --profile=binance1 --market=future --symbol=BTCUSDT --action=stop --stop-price=60000
```

## Strategi MA (7/25/99)

Bot bisa auto-trading dari data candle exchange (bukan TradingView) memakai MA cross + filter tren:

- **Long**: MA7 cross ke atas MA25 **dan** harga > MA99.
- **Short**: MA7 cross ke bawah MA25 **dan** harga < MA99.
- **dip_catcher** (opsional, `--dip`): long tambahan saat harga pullback menyentuh/di bawah MA25 lalu **reclaim** ke atas MA25, selama harga masih di atas MA99. Memperkuat MA dengan entry di pullback tren naik.
- Posisi berlawanan ditutup dulu (`close`) lalu buka arah baru.
- Sinyal dihitung dari candle yang **sudah closed** (anti-repaint).

```bash
# cek sinyal sekali (dry-run, tidak order)
node src/index.js strategy --profile=binance1 --market=future --symbol=BTCUSDT --amount=50 --timeframe=15m --dry-run

# eksekusi sekali
node src/index.js strategy --profile=binance1 --market=future --symbol=BTCUSDT --amount=50 --timeframe=15m

# pantau terus (polling, order hanya saat cross candle baru)
node src/index.js strategy --profile=binance1 --market=future --symbol=BTCUSDT --amount=50 --timeframe=15m --watch --interval=30

# aktifkan dip_catcher (dip ke MA25 + reclaim)
node src/index.js strategy --profile=binance1 --market=spot --symbol=BTCUSDT --amount=50 --timeframe=15m --dip --dip-lookback=5 --dry-run
```

Opsi: `--fast=7`, `--slow=25`, `--trend=99`, `--amount-type=quote|base`, `--dip`, `--dip-lookback=<n>` (default 3, jumlah candle ke belakang untuk mendeteksi sentuhan MA slow), `--dry-run`, `--watch`, `--interval` (detik).

## Konfigurasi

`config.json`:
- `server` — host/port webhook.
- `webhook.secret` — secret validasi (bisa `env:NAMA_ENV`).
- `webhook.ipAllowlist` — opsional; batasi IP pengirim. Kosong = semua diizinkan.
- `defaultProfile` — profile default bila payload tidak menyebut `profile`.
- `profiles[]` — `id`, `exchange` (id CCXT), `apiKey`/`secret` (bisa `env:...`), `leverage`, `marginMode`, `allowSpot`, `allowFutures`.
- `symbolMap` — pemetaan ticker TradingView ke simbol CCXT spot & futures.

Nilai yang diawali `env:` akan dibaca dari environment variable, jadi API key tidak perlu ditulis di file.

Pair tambahan disimpan terpisah di `watchlist.json` (tidak ikut git). Ticker yang belum terdaftar pun tetap dikenali otomatis bila berpola `<BASE><QUOTE>` (mis. `ADAUSDT` → spot `ADA/USDT`, future `ADA/USDT:USDT`).

## Hosting di Ubuntu (systemd)

Jalankan bot sebagai service yang auto-start saat boot dan auto-restart saat crash.

```bash
# 1. Prasyarat
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Sinkronkan jam server (wajib untuk API Binance, menghindari error -1021)
sudo timedatectl set-ntp true
timedatectl status

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

## Troubleshooting

Bot mengubah error exchange menjadi pesan yang mudah dibaca (baik di log, respons API, maupun dashboard).

| Error | Arti | Solusi |
| --- | --- | --- |
| `-1021` / `-5028` Timestamp outside recvWindow | Jam server tidak sinkron dengan Binance | `sudo timedatectl set-ntp true` lalu `sudo systemctl restart simple-trade-bot`. Bot juga otomatis menyesuaikan waktu (`adjustForTimeDifference`) dan `recvWindow` 60s |
| `-2015` Invalid API-key, IP, or permissions | Key salah / IP tidak diizinkan / Futures belum aktif | Cek API Management Binance: aktifkan izin yang diperlukan, cocokkan IP whitelist (atau kosongkan) |
| `-1022` Signature invalid | Secret key salah atau jam tidak sinkron | Periksa `BINANCE_SECRET` dan sinkronkan waktu |
| `-2022` / `-4164` ReduceOnly rejected | Tidak ada posisi, atau arah order salah | Pastikan ada posisi terbuka sebelum `close`/`stop` |
| `Tidak dapat menjangkau exchange` | Jaringan/DNS/VPN memblokir Binance | Gunakan VPN atau VPS di luar Indonesia; pastikan DNS normal |

Melihat error terbaru: `journalctl -u simple-trade-bot -n 50` atau file `logs/bot.log`.
