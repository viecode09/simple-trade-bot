const CODE_HINTS = {
  '-1021': 'Jam server tidak sinkron dengan Binance (timestamp di luar recvWindow). Sinkronkan waktu: "sudo timedatectl set-ntp true" lalu restart service.',
  '-5028': 'Jam server tidak sinkron (matching engine recvWindow). Sinkronkan waktu via NTP lalu restart service.',
  '-1022': 'Signature tidak valid — secret key salah atau jam tidak sinkron.',
  '-2014': 'Format API key salah.',
  '-2015': 'API key tidak valid / IP tidak diizinkan / izin Futures belum aktif. Cek API Management Binance.',
  '-1003': 'Rate limit terlampaui. Tunggu beberapa saat.',
  '-1015': 'Terlalu banyak request / IP dibatasi sementara.',
  '-1102': 'Parameter wajib tidak lengkap atau tidak valid.',
  '-1111': 'Presisi harga/quantity tidak sesuai aturan exchange.',
  '-2010': 'Order ditolak (NEW_ORDER_REJECTED).',
  '-2011': 'Order sudah tidak ada atau sudah terisi.',
  '-2022': 'Order reduceOnly ditolak (tidak ada posisi / arah salah).',
  '-4164': 'Order ditolak: posisi perlu reduceOnly atau terjadi konflik.',
  '-4131': 'Order ditolak karena melanggar batas posisi/strategi.',
  '-1013': 'Filter exchange tidak terpenuhi (minNotional/minQty).',
  '-4046': 'Tidak ada posisi terbuka untuk di-close/stop.',
  '-4061': 'Position side tidak cocok dengan setting akun (Hedge/One-way). Bot mencoba menyesuaikan otomatis; jika masih gagal, set "hedgeMode" (true/false) di profile config.json atau ubah Position Mode di Binance.'
};

const NETWORK_RE = /fetch failed|Connect Timeout|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|timed? ?out|network/i;

export function describeError(error) {
  const raw = (error && error.message) ? error.message : String(error);

  const codeMatch = raw.match(/"code"\s*:\s*(-?\d+)/) || raw.match(/\b(-1\d{3})\b/);
  const code = codeMatch ? codeMatch[1] : null;

  if (code && CODE_HINTS[code]) {
    return `${CODE_HINTS[code]} [${code}]`;
  }

  if (NETWORK_RE.test(raw)) {
    return `Tidak dapat menjangkau exchange (jaringan/DNS/VPN). Detail: ${raw}`;
  }

  return raw;
}
