# Telegram Codex Manager

Bot Telegram lokal untuk mengelola beberapa profil Codex CLI. Implementasi menyelesaikan **Tahap 1–6** dari `PROJECT.md`.

## Prasyarat

- Node.js 20.11 atau lebih baru dan npm
- Token bot Telegram dari `@BotFather`
- Numeric Telegram user ID yang diizinkan

## Instalasi lokal

```bash
npm install
cp .env.example .env
```

Isi `.env`:

```dotenv
BOT_TOKEN=token_dari_botfather
ALLOWED_TELEGRAM_IDS=123456789
CODEX_BIN=codex
DATA_DIR=./data
```

`ALLOWED_TELEGRAM_IDS` menerima satu atau beberapa ID numerik, dipisahkan koma. Jangan commit `.env`; token tidak dicetak ke log. `CODEX_BIN` menentukan executable Codex dan `DATA_DIR` menentukan lokasi metadata serta profil.

## Menjalankan

```bash
npm start
```

Bot berjalan dengan long polling, sehingga tidak perlu membuka port lokal ke internet. User yang tidak terdaftar di allowlist menerima penolakan. Hentikan proses dengan Ctrl+C.

Pemeriksaan sintaks:

```bash
npm run check
npm test
```

Dashboard menyimpan `chat_id` dan `message_id` di `data/profiles.json`, mengedit pesan tersebut untuk navigasi, dan membuat pesan pengganti jika edit gagal. Metadata profil dan pilihan aktif per user juga disimpan di file yang sama; setiap profil memiliki direktori `CODEX_HOME` di `data/profiles/<uuid>/`. Telegram hanya mengizinkan satu `reply_markup` per pesan; karena itu `/start` memasang Reply Keyboard melalui pesan menu ringkas dan menampilkan dashboard inline terpisah.

Login Codex menyediakan ChatGPT OAuth, Device Code, dan API key. Bot memeriksa `codex login --help` pada `CODEX_HOME` profil dan hanya menawarkan flag yang didukung. API key diterima di private chat, pesan pengirim dihapus best effort, lalu key dikirim melalui stdin proses Codex. Semua jalur baru dinyatakan berhasil setelah `codex login status` keluar sukses. OAuth dan device login harus dimulai dari private chat karena instruksi autentikasi dapat berisi URL atau kode sementara.

Quota dashboard menggunakan provider terpisah. Saat ini nilainya `Unavailable` dengan sumber dan waktu pengecekan; autentikasi tidak digunakan untuk menyimpulkan quota. Lihat usage dashboard resmi ChatGPT untuk batas dan reset terkini. `/status` hanya tersedia di dalam sesi Codex CLI aktif.

Logout akun dan penghapusan profil meminta konfirmasi. Logout menggunakan `codex logout` hanya bila CLI terpasang mendukungnya; penghapusan profil juga menghapus direktori `CODEX_HOME` dan kredensial di dalamnya.

## Backup dan pemulihan

Direktori `data/` (atau nilai `DATA_DIR` yang dikonfigurasi) berisi kredensial Codex. Hentikan bot dengan Ctrl+C sebelum membuat backup, simpan arsip di disk terenkripsi yang hanya dapat diakses oleh user OS bot, dan jangan menaruh backup di repo. Ganti nama `data` pada perintah berikut jika memakai `DATA_DIR` lain:

```bash
umask 077
tar -cf /path/ke/disk-terenkripsi/codex-manager-data.tar data
```

Untuk pemulihan, hentikan bot, ekstrak arsip kembali di direktori project, pastikan owner file adalah user OS bot dan permission direktori/file tetap ketat, lalu jalankan `npm start`. Jangan mengirim arsip atau file autentikasi ke chat, issue, atau log.

Jalankan bot menggunakan user OS non-root. Lindungi `.env`, folder profil, dan media backup; enkripsi disk penuh disarankan untuk mesin yang menyimpan akun.
