# Telegram Codex Manager

Dokumen spesifikasi dan panduan implementasi untuk membangun bot Telegram yang mengelola beberapa profil autentikasi Codex CLI pada komputer lokal.

> **Status:** Project specification / implementation brief
> **Target runtime:** Node.js 20.11+
> **Telegram framework:** Telegraf 4
> **Mode deployment:** Local machine
> **Shell policy:** Allowlist only
> **Account model:** Multiple isolated Codex profiles

---

## 1. Tujuan proyek

Membangun bot Telegram pribadi untuk:

1. Membuat dan mengelola beberapa profil Codex CLI.
2. Login ke setiap profil menggunakan metode yang didukung Codex CLI.
3. Menampilkan status autentikasi profil aktif.
4. Menyediakan dashboard quota/usage.
5. Memakai **Inline Keyboard** pada dashboard sebagai navigasi utama.
6. Memakai **Inline Keyboard** untuk navigasi dan aksi.
7. Mengedit satu pesan dashboard yang sama dengan `editMessageText` agar chat tidak dipenuhi pesan baru.
8. Menjalankan hanya perintah lokal yang sudah di-allowlist, bukan shell bebas.

Bot berjalan di komputer lokal yang memiliki Codex CLI terpasang. Bot tidak menjadi layanan cloud dan tidak boleh mengekspos port lokal ke internet.

## 2. Batasan dan prinsip penting

### 2.1 Quota Codex

Jangan mengarang endpoint quota, endpoint privat, atau angka penggunaan.

Implementasi harus membedakan tiga jenis informasi:

- **Authentication status:** apakah profil berhasil login (`codex login status`).
- **CLI status information:** informasi yang benar-benar dikeluarkan Codex CLI, misalnya `/status` di dalam sesi interaktif jika tersedia.
- **Account usage / quota:** batas pemakaian dan waktu reset yang dikembalikan antarmuka resmi Codex. Codex App Server menyediakan `account/rateLimits/read`, tetapi App Server masih experimental dan protokolnya dapat berubah antar versi.

`codex login status` hanya memverifikasi status login. Perintah ini **bukan** API quota.

Gunakan `codex app-server` melalui stdio dan `account/rateLimits/read` bila versi CLI terpasang mendukungnya. Jangan mengakses endpoint web/internal secara langsung, mengambil token dari file auth, atau mengarang angka quota. Jika App Server tidak tersedia, request gagal, atau respons tidak berisi usage, dashboard harus menampilkan `Quota source unavailable`.

Quota dashboard tetap dapat dibuat sebagai UI dengan status:
- Authentication: Connected / Not connected
- Usage source: Available / Unavailable
- Last checked
- Reset time: hanya jika sumber resmi mengembalikannya
- Usage windows: hanya jika sumber resmi mengembalikannya

### 2.2 Metode login

Sediakan tiga pilihan menu yang diminta:

1. **Sign in with ChatGPT** — jalankan `codex login`. Codex akan memulai alur browser OAuth. Di mesin lokal dengan browser, pengguna menyelesaikan autentikasi di browser.
2. **Sign in with Device Code** — jalankan `codex login --device-auth` jika opsi ini tersedia pada versi Codex CLI terpasang. Ini ditujukan untuk lingkungan tanpa browser dan dapat berstatus beta/bergantung versi.
3. **Sign in another way (API key)** — jalankan `codex login --with-api-key` dan kirim API key melalui stdin proses. Jangan pernah menaruh key di argumen command line, log, callback Telegram, atau file konfigurasi bot.

Sebelum implementasi, verifikasi opsi yang didukung versi CLI terpasang dengan `codex login --help`. Jika flag tidak tersedia, tampilkan pesan versi/fitur tidak didukung. Jangan mengasumsikan semua versi CLI memiliki perilaku identik.

### 2.3 Satu pesan dashboard

Telegram tidak menyediakan satu pesan universal yang bisa diedit lintas semua interaksi. Implementasikan pola berikut:

- `/start` membuat atau memperbarui pesan dashboard untuk chat tersebut.
- Simpan `chat_id` dan `message_id` dashboard di penyimpanan lokal.
- Semua callback inline mengedit pesan tersebut dengan `editMessageText`.
- Jika pesan sudah tidak ada atau tidak bisa diedit, buat pesan dashboard baru lalu simpan `message_id` pengganti.
- Inline Keyboard pada satu pesan dashboard menjadi navigasi utama; `/start` memperbarui pesan yang sama.
- Jangan mengirim pesan baru untuk setiap klik. Pesan baru hanya boleh digunakan untuk kasus yang memang perlu, seperti instruksi login rahasia yang harus segera dihapus atau fallback ketika pesan dashboard hilang.

---

## 3. Arsitektur

```text
Telegram User
    |
    v
Telegraf Bot (Node.js)
    |
    +-- Access Control (Telegram user ID allowlist)
    |
    +-- UI Controller
    |     +-- Inline Keyboard
    |     +-- Dashboard message editor
    |
    +-- Profile Manager
    |     +-- Create profile
    |     +-- Select profile
    |     +-- Delete profile
    |
    +-- Codex CLI Adapter
    |     +-- codex login
    |     +-- codex login --device-auth
    |     +-- codex login --with-api-key
    |     +-- codex login status
    |
    +-- Usage Provider
    |     +-- Official supported source only
    |     +-- Explicit unavailable state if no supported source
    |
    +-- Allowlisted Local Tasks
          +-- codex --version
          +-- codex login status
          +-- Other explicitly approved fixed commands
```

### 3.1 Isolasi multi-account

Gunakan satu direktori `CODEX_HOME` per profil. Contoh:

```text
project/
├── .env
├── data/
│   ├── profiles.json
│   └── profiles/
│       ├── <profile-uuid-1>/
│       │   └── ... Codex profile data ...
│       └── <profile-uuid-2>/
│           └── ... Codex profile data ...
└── src/
```

Saat menjalankan proses Codex untuk profil tertentu, set:

```js
env: {
  ...process.env,
  CODEX_HOME: profile.home
}
```

Jangan mengubah `CODEX_HOME` global proses bot ketika ada beberapa request bersamaan. Set environment pada masing-masing child process.

Direktori profil mengandung kredensial sensitif. Batasi permission ke user OS yang menjalankan bot (`0700` untuk direktori dan `0600` untuk file metadata bila didukung).

### 3.2 Penyimpanan

Simpan metadata berikut saja:

```json
{
  "profiles": [
    {
      "id": "uuid",
      "name": "Personal",
      "home": "/absolute/path/to/data/profiles/uuid",
      "createdAt": "ISO-8601 timestamp"
    }
  ],
  "selected": {
    "telegram-user-id": "profile-uuid"
  },
  "dashboards": {
    "telegram-chat-id": {
      "messageId": 123
    }
  }
}
```

Jangan menyimpan password, API key, access token, refresh token, atau isi file autentikasi di `profiles.json`.

---

## 4. UX Telegram

### 4.1 Inline Keyboard — menu utama

Contoh layout:

```text
┌──────────────────┬──────────────────┐
│ 🔐 Login Codex   │ 📊 Check Quota   │
├──────────────────┼──────────────────┤
│ 👤 Accounts      │ ⚙️ Settings      │
└──────────────────┴──────────────────┘
```

### 4.2 Dashboard message

Contoh tampilan `/start`:

```text
🤖 CODEX MANAGER

Bot ini mengelola profil login Codex CLI dan merangkum quota semua profil.

ACCOUNT                          WINDOW    USED   LEFT
person@example.com               Weekly    40%    60%
```

Inline buttons:

```text
[🔐 Login] [👤 All account quotas]
[⚙️ Settings]
```

Halaman All account quotas menampilkan tiap profil dalam tabel:

```text
ACCOUNT                          WINDOW    USED   LEFT
person@example.com               Weekly    40%    60%
                                 Reset: 2026-11-08 21:00 local
```

Tombol Refresh all quotas berada di halaman ini. Tombol Back kembali ke ringkasan `/start` tanpa memilih akun.

Jangan menampilkan persentase atau angka quota jika tidak diperoleh dari sumber resmi.

### 4.3 Login menu

```text
Pilih metode login:

[Sign in with ChatGPT]
[Sign in with Device Code]
[Sign in another way (API Key)]
[Back]
```

#### ChatGPT OAuth

- Jalankan `codex login` di child process dengan `CODEX_HOME` profil yang dipilih.
- Tangkap stdout dan stderr secara terbatas.
- Jika CLI mengeluarkan URL login, ekstrak URL yang valid dan kirim sebagai inline URL button.
- Jangan mengubah URL atau menambahkan parameter sendiri.
- User membuka link dan menyelesaikan login di browser.
- Pantau proses sampai exit.
- Verifikasi hasil dengan `codex login status` pada `CODEX_HOME` yang sama.
- Jangan menganggap membuka link sebagai login sukses.

#### Device Code

- Jalankan `codex login --device-auth`.
- Tampilkan verification URL dan user code jika benar-benar dikeluarkan CLI.
- Berikan instruksi membuka URL dan memasukkan kode.
- Jangan menebak verification URL atau membuat kode sendiri.
- Pantau proses hingga selesai dan verifikasi dengan `codex login status`.
- Terapkan timeout dan tombol Cancel.

#### API Key

- Minta API key melalui private chat saja.
- Pastikan pesan pengguna tidak diteruskan ke log.
- Gunakan `codex login --with-api-key` dengan stdin.
- Jangan menyertakan key di command arguments atau environment variable jika CLI menyediakan stdin.
- Hapus pesan Telegram yang berisi key sesegera mungkin setelah diterima (best effort; Telegram dapat menolak penghapusan berdasarkan hak/umur pesan).
- Hapus referensi key dari memori aplikasi setelah proses selesai.
- Jangan pernah meng-echo key ke user, log, error report, atau dashboard.
- Jika API key diterima di grup, tolak dan arahkan user ke private chat.

### 4.4 Multi-account

Aksi yang diperlukan:

- Login method membuat profil akun baru secara otomatis
- List accounts
- Check login status
- Delete account (dengan konfirmasi)
- Logout account (gunakan perintah logout yang didukung CLI versi terpasang; jangan hapus profil sebelum user mengonfirmasi)
- Rename account (metadata saja)

Setiap metode login membuat profil baru dengan nama sementara. Setelah login ChatGPT terverifikasi, email akun dipakai sebagai nama di tabel All account quotas saja; dashboard dan pesan login tetap memakai label generik. Daftar akun menampilkan tabel quota dan aksi Delete untuk tiap profil; daftar tidak menyediakan switch account.

Setiap profil mempunyai `CODEX_HOME` sendiri. Profile yang aktif hanya konteks pilihan UI; setiap child process tetap harus diberi `CODEX_HOME` eksplisit.

---

## 5. Allowlist command execution

User memilih shell allowlist. Karena itu **jangan** implementasikan fitur “run any shell command”, terminal bebas, `exec(userInput)`, atau `spawn("sh", ["-c", userInput])`.

Gunakan pemetaan action ke command tetap:

```js
const COMMANDS = {
  codexVersion: {
    bin: "codex",
    args: ["--version"],
    timeoutMs: 10_000
  },
  loginStatus: {
    bin: "codex",
    args: ["login", "status"],
    timeoutMs: 15_000
  }
};
```

Eksekusi dengan `spawn(binary, args, { shell: false, env, cwd })`.

Aturan:
- Tidak ada interpolasi input Telegram ke command string.
- Tidak ada `shell: true`.
- Validasi nama profil berdasarkan ID internal, bukan path dari pengguna.
- Timeout untuk setiap proses.
- Batasi ukuran stdout/stderr.
- Redact secret dari error output.
- Jangan mengirim environment variables ke Telegram.
- Jangan menjalankan `sudo`, `rm`, `curl`, `wget`, `bash`, `sh`, atau command arbitrary.
- Logout dan delete profile adalah operasi khusus dengan konfirmasi dan validasi target.

---

## 6. Quota / usage provider

Buat interface terpisah agar implementasi quota tidak tercampur dengan autentikasi.

```ts
type UsageResult = {
  available: boolean;
  source: string;
  checkedAt: string;
  windows?: Array<{
    label: string;
    used?: number;
    limit?: number;
    remaining?: number;
    resetAt?: string;
    unit?: string;
  }>;
  message?: string;
};
```

Provider awal yang aman:

```js
export async function getUsage(profile) {
  return {
    available: false,
    source: "supported-codex-cli",
    checkedAt: new Date().toISOString(),
    message:
      "The installed Codex CLI does not expose a documented quota endpoint. " +
      "Check the official ChatGPT usage settings for account limits."
  };
}
```

Ketentuan:
- `codex login status` hanya untuk autentikasi.
- Jangan parse teks login status sebagai quota.
- Jangan klaim `/status` bisa dipanggil sebagai standalone command kecuali versi CLI mendokumentasikannya.
- `/status` merupakan perintah dalam sesi interaktif Codex; jangan mengasumsikan outputnya tersedia lewat `codex status`.
- Jika kelak OpenAI mendokumentasikan API quota publik, implementasikan provider baru dengan dokumentasi, schema, autentikasi, dan rate limit yang jelas.
- Simpan waktu pengecekan dan tampilkan “unavailable” jika sumber tidak dapat diverifikasi.

---

## 7. Alur callback dan dashboard editor

Sediakan satu fungsi pusat:

```js
async function renderDashboard(ctx, text, keyboard) {
  const saved = await getDashboardMessage(ctx.chat.id);

  if (saved?.messageId) {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        saved.messageId,
        undefined,
        text,
        {
          parse_mode: "HTML",
          reply_markup: keyboard
        }
      );
      return saved.messageId;
    } catch (error) {
      // "message is not modified" dapat diperlakukan sebagai sukses.
      // Jika message not found / can't be edited, kirim pesan pengganti.
      if (String(error.description || error.message).includes("message is not modified")) {
        return saved.messageId;
      }
    }
  }

  const sent = await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: keyboard
  });
  await saveDashboardMessage(ctx.chat.id, sent.message_id);
  return sent.message_id;
}
```

Implementasi produksi harus:
- Menghindari HTML injection dengan escaping text dinamis.
- Memastikan semua callback menjawab `answerCbQuery()`.
- Menangani `message is not modified`.
- Menangani dashboard yang dihapus user.
- Mengunci update per chat agar dua callback cepat tidak saling menimpa.
- Tidak membocorkan detail exception ke Telegram.

---

## 8. Security checklist

- [ ] Bot hanya menerima user ID dalam `ALLOWED_TELEGRAM_IDS`.
- [ ] Tolak semua request dari user yang tidak diizinkan.
- [ ] API key hanya diterima di private chat.
- [ ] Jangan log token, API key, OAuth URL yang mengandung secret, atau file auth.
- [ ] Jangan pernah mengirim isi `auth.json` ke Telegram.
- [ ] `CODEX_HOME` terpisah untuk setiap akun.
- [ ] Folder `data/` tidak masuk Git.
- [ ] File `.env` tidak masuk Git.
- [ ] Gunakan `spawn` dengan `shell: false`.
- [ ] Hanya command allowlist yang dapat dijalankan.
- [ ] Terapkan timeout, output limit, dan cancellation.
- [ ] Konfirmasi sebelum logout atau menghapus profil.
- [ ] Jangan expose bot melalui public webhook; gunakan long polling untuk local setup.
- [ ] Jalankan bot dengan user OS non-root.
- [ ] Lindungi disk dan backup karena folder profil berisi kredensial.
- [ ] Pertimbangkan enkripsi disk penuh untuk komputer yang menyimpan akun.

---

## 9. Struktur project yang disarankan

```text
codex-telegram-manager/
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
├── README.md
├── PROJECT.md
├── data/                       # ignored by git
│   ├── profiles.json
│   └── profiles/
└── src/
    ├── index.js                # entry point, Telegraf, long polling
    ├── config.js               # env validation
    ├── access.js               # Telegram user allowlist
    ├── store.js                # metadata persistence
    ├── dashboard.js            # single-message editor
    ├── keyboards.js            # reply and inline keyboards
    ├── handlers/
    │   ├── start.js
    │   ├── accounts.js
    │   ├── login.js
    │   ├── quota.js
    │   └── settings.js
    ├── services/
    │   ├── codex.js             # Codex CLI adapter
    │   ├── usage.js             # quota provider abstraction
    │   └── process-runner.js    # safe allowlisted spawn helper
    └── utils/
        ├── escape-html.js
        ├── redact.js
        └── locks.js
```

---

## 10. Setup local

### Prasyarat

- Node.js 20.11 atau lebih baru.
- npm.
- Telegram bot token dari `@BotFather`.
- Codex CLI terpasang dan dapat dipanggil dari terminal.
- User OS yang menjalankan bot memiliki permission ke direktori data.

### Install

```bash
mkdir codex-telegram-manager
cd codex-telegram-manager
npm init -y
npm install telegraf dotenv
```

Buat `.env`:

```dotenv
BOT_TOKEN=your_telegram_bot_token
ALLOWED_TELEGRAM_IDS=your_numeric_telegram_user_id
CODEX_BIN=codex
DATA_DIR=./data
```

Jalankan pemeriksaan Codex CLI:

```bash
codex --version
codex login --help
codex login status
```

Pastikan pilihan login yang akan dipakai memang tersedia pada versi CLI terpasang. Jangan menyalin token atau isi file autentikasi ke issue, chat, atau log.

Jalankan bot:

```bash
npm start
```

Gunakan long polling untuk komputer lokal. Jangan membuka port publik hanya untuk menjalankan bot.

---

## 11. Rencana implementasi bertahap di Codex CLI

Kerjakan bertahap supaya Codex dapat memeriksa dan menguji setiap bagian.

### Tahap 1 — Bootstrap

Prompt Codex:

> Baca `PROJECT.md` sampai selesai. Buat struktur project Node.js ESM dengan Telegraf 4, dotenv, konfigurasi `.env.example`, `.gitignore`, validasi environment, dan entry point long polling. Jangan implementasikan arbitrary shell execution. Tambahkan README setup local. Jalankan pemeriksaan syntax dan laporkan file yang dibuat.

Acceptance:
- Bot start tanpa error.
- Token dan allowlist divalidasi.
- User non-allowlisted ditolak.
- Token tidak pernah dicetak ke log.

### Tahap 2 — Dashboard satu pesan

Prompt Codex:

> Implementasikan Inline Keyboard sebagai menu utama. `/start` menampilkan penjelasan bot di satu pesan dashboard. Buat dashboard editor yang menyimpan chat_id/message_id dan mengedit pesan yang sama dengan `editMessageText`. Tangani message is not modified, pesan terhapus, callback query, HTML escaping, dan race condition update per chat. Setiap pilihan metode Login membuat profil baru otomatis tanpa menampilkan email. Tambahkan test untuk dashboard helper.

Acceptance:
- Tombol menu utama tersedia.
- Klik inline button mengedit dashboard.
- Pesan baru hanya dibuat sebagai fallback.
- Callback selalu dijawab.

### Tahap 3 — Multi-profile

Prompt Codex:

> Implementasikan profile manager dengan direktori CODEX_HOME terpisah untuk setiap akun. Metadata disimpan dalam JSON dengan atomic write dan permission ketat. Tambahkan create/list/select/rename/delete dengan konfirmasi sebelum delete. Jangan menyimpan credential ke metadata.

Acceptance:
- Dua profil memiliki direktori berbeda.
- Setiap proses Codex menggunakan `CODEX_HOME` profil yang benar.
- Delete meminta konfirmasi.
- File data tidak masuk Git.

### Tahap 4 — Codex login

Prompt Codex:

> Implementasikan adapter Codex CLI. Sediakan ChatGPT OAuth menggunakan `codex login`, device code menggunakan `codex login --device-auth` hanya jika didukung oleh `codex login --help`, dan API key menggunakan `codex login --with-api-key` melalui stdin. Tangkap URL/code yang benar-benar dicetak CLI, jangan membuat URL/code sendiri. Verifikasi login dengan `codex login status`. Tambahkan cancel, timeout, satu proses login per profil, redaction, dan penanganan proses yang gagal.

Acceptance:
- Ketiga jalur tidak mengklaim sukses sebelum status diverifikasi.
- Tidak ada secret dalam log.
- Device auth yang tidak didukung ditangani dengan pesan jelas.
- API key tidak berada di command arguments.

### Tahap 5 — Quota dashboard

Prompt Codex:

> Buat usage provider abstraction memakai `codex app-server` melalui stdio dan metode `account/rateLimits/read` jika didukung versi CLI terpasang. Tandai sumber ini experimental dan tangani perubahan protokol, timeout, akun API key, dan respons tanpa usage dengan status unavailable. Jangan scrape endpoint web/internal atau menyimpulkan quota dari login status. Dashboard harus menunjukkan source, last checked, jendela usage, reset time, dan alasan unavailable.

Acceptance:
- Tidak ada angka quota palsu.
- Authentication dan usage status terpisah.
- Refresh mengedit dashboard yang sama.

### Tahap 6 — Hardening dan test

Prompt Codex:

> Audit seluruh project berdasarkan bagian Security checklist di PROJECT.md. Pastikan tidak ada `shell: true`, `exec(userInput)`, command interpolation, secret logging, atau akses tanpa allowlist. Tambahkan unit test untuk access control, profile isolation, redaction, command allowlist, dan dashboard update. Jalankan semua test dan laporkan risiko yang masih tersisa.

---

## 12. Test plan

Minimal test yang harus tersedia:

| Area | Test |
|---|---|
| Access control | User ID tidak terdaftar ditolak |
| Access control | User ID terdaftar diizinkan |
| Profiles | Buat dua profile menghasilkan dua CODEX_HOME |
| Profiles | Profile baru menjadi profile aktif untuk login |
| Profiles | Delete butuh konfirmasi |
| Process runner | Tidak ada `shell: true` |
| Process runner | Input pengguna tidak dapat menambah argumen |
| Process runner | Timeout membunuh child process |
| Redaction | API key/token tidak muncul di output |
| Login | Exit sukses tetap diverifikasi dengan `codex login status` |
| Login | Device auth unsupported ditangani |
| Login | Cancel menghentikan child process |
| Dashboard | Callback mengedit message ID tersimpan |
| Dashboard | Pesan hilang membuat pengganti |
| Dashboard | “message is not modified” tidak membuat pesan baru |
| Usage | Login status tidak dipetakan menjadi quota |
| Usage | Provider unavailable menampilkan status unavailable |

Gunakan mock untuk pengujian proses. Jangan memakai akun atau credential produksi dalam automated test.

---

## 13. Dokumentasi resmi yang harus dijadikan acuan

Selalu cek ulang karena opsi CLI dan perilaku autentikasi dapat berubah.

- Codex CLI overview: https://developers.openai.com/codex/cli/
- Codex authentication: https://developers.openai.com/codex/auth/
- Codex CLI command reference: https://developers.openai.com/codex/cli/reference/
- Codex security: https://developers.openai.com/codex/security/
- Codex pricing / usage information: https://developers.openai.com/codex/pricing/
- Telegraf documentation: https://telegraf.js.org/
- Telegram Bot API — editMessageText: https://core.telegram.org/bots/api#editmessagetext
- Telegram Bot API — InlineKeyboardButton: https://core.telegram.org/bots/api#inlinekeyboardbutton
- Telegram Bot API — ReplyKeyboardMarkup: https://core.telegram.org/bots/api#replykeyboardmarkup

Jika URL dokumentasi berpindah, cari dokumentasi Codex di domain `developers.openai.com` dan Telegram Bot API di `core.telegram.org`. Jangan menganggap blog atau contoh komunitas sebagai spesifikasi resmi.

---

## 14. Definition of done

Project dianggap selesai ketika:

1. Bot berjalan lokal menggunakan long polling.
2. Hanya Telegram user ID yang diizinkan dapat mengakses bot.
3. Menu utama memakai Inline Keyboard dan tidak memasang Reply Keyboard.
4. Inline navigation mengedit satu dashboard message.
5. Pengguna dapat membuat dan memilih beberapa profil Codex.
6. Setiap profil memakai `CODEX_HOME` terisolasi.
7. Ketiga metode login ditawarkan sesuai dukungan CLI yang terpasang.
8. Login hanya dinyatakan berhasil setelah `codex login status` mengonfirmasi.
9. API key tidak masuk log atau command line.
10. Tidak ada shell bebas; hanya allowlist.
11. Dashboard quota tidak mengarang data dan membedakan status login dari usage.
12. Ada test untuk kontrol akses, profile isolation, login process, redaction, dan dashboard.
13. README menjelaskan instalasi, konfigurasi, start/stop, backup, dan pemulihan profil.

**Prioritas implementasi:** keamanan dan isolasi profil terlebih dahulu, lalu login, lalu dashboard, terakhir quota provider. Jangan mengorbankan keamanan untuk mengejar tampilan quota real-time yang belum didukung interface resmi.
