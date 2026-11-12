# DESIGN.md — Warm Tactile Bento System

Dokumen ini adalah panduan wajib bagi AI dalam merancang UI, menulis kode CSS/Tailwind, serta menyusun *copywriting*. Seluruh komponen harus mengikuti estetika **Warm Bento Neumorphism** dan mematuhi aturan **Anti-Slop**.

---

## 1. Identitas Visual & Tata Letak (Bento Grid)
- **Struktur Utama:** Gunakan *Asymmetric Bento Grid* (CSS Grid) dengan komposisi kotak yang bervariasi (misal: gabungan `col-span-2`, `row-span-2`, dan kartu `1x1`) agar dinamis dan tidak monoton.
- **Dimensi & Jarak:**
  - Container maksimal: `1200px` dengan padding luar yang lega (`24px` - `40px`).
  - Jarak antar kartu (*grid gap*): `20px` hingga `24px`.
  - Sudut membulat (*border-radius*): `24px` untuk kartu bento utama, `14px` untuk tombol dan elemen di dalam kartu.
- **Hierarki Kedalaman (Neumorphism):**
  - Efek timbul (*extruded*) **HANYA** diterapkan pada wadah kartu bento utama dan tombol aksi utama (CTA).
  - Efek cekung (*inset*) **HANYA** diterapkan pada kolom input, *progress bar*, bingkai media/foto, atau indikator status.
  - Konten di dalam kartu (teks, angka, ikon, grafik) **WAJIB datar (*flat*)** agar kontras tetap tinggi dan mudah dibaca.

---

## 2. Sistem Warna (Warm Brown Palette)
*Catatan: Jangan pernah menggunakan warna putih murni (`#FFFFFF`), hitam pekat (`#000000`), atau bayangan hitam transparan (`rgba(0,0,0,x)`) karena akan membuat nuansa cokelat terlihat kusam.*

### Mode Utama: Warm Oat / Latte (Terang & Organik)
- **Latar Belakang & Permukaan Kartu:** `#E6DDD3`
- **Bayangan Terang (*Top-Left Highlight*):** `#F7F1EA`
- **Bayangan Gelap (*Bottom-Right Shadow*):** `#CFC4B8`
- **CSS Box-Shadow Timbul (*Extruded*):** `-7px -7px 16px #F7F1EA, 7px 7px 16px #CFC4B8`
- **CSS Box-Shadow Cekung (*Inset*):** `inset 4px 4px 10px #CFC4B8, inset -4px -4px 10px #F7F1EA`
- **Garis Tepi Halus (*Subtle Border*):** `1px solid rgba(255, 255, 255, 0.35)`
- **Teks Utama (*Heading* & Kontras Tinggi):** `#2E231C`
- **Teks Sekunder (*Body* & Label):** `#635347`
- **Warna Aksen Utama (CTA & Indikator Aktif):** `#9E5834` (Terakota hangat) dengan teks `#F7F1EA`
- **Warna Aksen Sekunder (Status/Badge):** `#4D6B53` (Hijau sage)

*(Opsional: Jika diminta menggunakan Mode Gelap / Warm Espresso, gunakan dasar `#2C241E`, highlight `#382E26`, shadow `#201A16`, teks `#F5EFE6`, dan aksen `#D97736`.)*

---

## 3. Tipografi
- **Font Judul (*Headings*):** `Fraunces` atau `Lora` (Serif lembut dengan karakter hangat). Gunakan *font-weight* `600` atau `700` dengan *letter-spacing* sedikit rapat (`-0.02em`).
- **Font Isi & UI (*Body & Controls*):** `Plus Jakarta Sans` atau `Inter`. Gunakan ukuran minimal `15px` atau `16px` untuk teks bacaan dengan `line-height: 1.6`.
- **Angka & Data:** Gunakan `tabular-nums` pada statistik atau harga agar sejajar rapi di dalam kotak bento.

---

## 4. Aturan Ketat Anti-Slop (WAJIB DIPATUHI)

### A. Larangan Visual & UI
- **DILARANG** menggunakan gradasi warna ungu, biru neon, atau efek pendar cahaya (*glow*) khas situs AI generik.
- **DILARANG** menggunakan efek kaca buram (*glassmorphism* / `backdrop-blur`) di atas warna cokelat.
- **DILARANG** menaruh ikon standar di dalam kotak kecil berwarna pastel di setiap judul kartu. Gunakan ikon secara hemat dan fungsional saja.
- **DILARANG** membuat tautan mati (`href="#"`) atau tombol tanpa fungsi interaksi (`hover` dan `active` state harus terasa menekan ke dalam untuk tombol neumorfik).

### B. Larangan Copywriting & Konten
- **DILARANG** menggunakan kalimat klise pembuka khas AI seperti: *"Unleash the power of..."*, *"Elevate your..."*, *"Reimagine..."*, *"In today's fast-paced world..."*, atau terjemahan Indonesianya (*"Tingkatkan potensi..."*, *"Buka kekuatan..."*).
- **DILARANG** menggunakan emoji di dalam judul, subjudul, maupun poin daftar (seperti 🚀, ✨, ⚡, 🔥).
- **DILARANG** menggunakan tanda pisah panjang (*em-dash* `—`) secara berlebihan di dalam paragraf.
- **DILARANG** menggunakan nama *placeholder* klise seperti "Sarah Jenkins", "John Doe", "Alex Rivera", atau "Jane Smith". Gunakan nama lokal yang natural atau nama merek/klien yang realistis.
- **Gaya Bahasa:** Tulis kalimat yang singkat, langsung pada inti produk, dan menjelaskan manfaat nyata tanpa kata-kata hiperbolis.
