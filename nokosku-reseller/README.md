# NOKOSKU Reseller Starter

Starter website reseller dengan frontend responsif, backend Node.js/Express, SQLite, login, wallet internal, katalog layanan, pemesanan, status/cancel, dan panel admin. Integrasi provider memakai API `https://api.nomorotp.id/` sesuai dokumentasi yang diberikan.

## Penting sebelum online

- Gunakan hanya layanan yang diizinkan oleh provider dan platform tujuan. Jangan gunakan untuk menghindari pembatasan, membuat akun massal, atau menyalahgunakan OTP.
- Ini starter, bukan sistem siap produksi. Session default Express disimpan di memory; pasang persistent session store saat production.
- **QRIS `createDeposit` di sini mengisi saldo akun provider/owner, bukan saldo pelanggan NOKOSKU.** Untuk pembayaran pelanggan otomatis, daftarkan payment gateway terpisah dan verifikasi callback/webhook di server. Jangan pernah menganggap pelanggan sudah bayar hanya dari screenshot.
- Saldo pelanggan demo hanya bisa ditambah admin setelah pembayaran benar-benar diverifikasi.
- API key hanya di `.env` server, jangan dimasukkan ke `public/index.html`.
- Wajib HTTPS di hosting publik; gunakan session secret dan password admin yang kuat.

## Menjalankan di Android (Termux)

1. Install Node.js LTS dan Git dari Termux:
   ```sh
   pkg update && pkg upgrade
   pkg install nodejs-lts git
   ```
2. Ekstrak ZIP ini ke folder yang bisa diakses Termux, lalu masuk ke folder `nokosku-reseller`.
3. Pasang dependensi:
   ```sh
   npm install
   cp .env.example .env
   nano .env
   ```
4. Ubah `SESSION_SECRET`, `ADMIN_PASSWORD`, dan `NOMOROTP_API_KEY`. API key didapat dari akun provider sendiri; jangan dibagikan.
5. Jalankan:
   ```sh
   npm start
   ```
6. Buka browser Android ke `http://127.0.0.1:3000`.
7. Login admin memakai `ADMIN_USERNAME` dan `ADMIN_PASSWORD` yang diatur di `.env`.

## Menjalankan di PC

Install Node.js 20+, buka terminal di folder project, jalankan `npm install`, salin `.env.example` menjadi `.env`, isi konfigurasi, lalu `npm start`. Buka `http://localhost:3000`.

## Konfigurasi penting

- `NOMOROTP_API_KEY`: token rahasia provider.
- `NOMOROTP_BASE_URL`: default `https://api.nomorotp.id/`.
- `RESELLER_MARGIN_PERCENT`: margin jual, misalnya 25 berarti 25%.
- `ALLOW_PUBLIC_REGISTER`: set `false` untuk menutup pendaftaran publik.

## Fitur yang ada

- Daftar/login pelanggan dan admin
- Katalog layanan/negara dari provider
- Harga jual indikatif berdasarkan margin
- Pemesanan dan saldo internal
- Cek status pesanan dan pembatalan
- Panel admin, ledger, penyesuaian saldo
- Deposit QRIS untuk saldo akun provider

## Belum termasuk

- Payment gateway pelanggan + webhook terverifikasi
- Verifikasi email, reset password, MFA
- Persistent session store, audit log lanjutan, backup otomatis
- Deployment production, domain, TLS, monitoring
- Kebijakan/refund khusus bisnis dan invoice

## Catatan implementasi

API harga dapat berubah dan respons harga dapat berbeda menurut server/negara. Uji di akun provider dengan saldo kecil. Untuk production, tambahkan transaksi/idempotency yang lebih kuat dan rekonsiliasi order jika provider berhasil membuat aktivasi tetapi database lokal gagal menyimpan.
