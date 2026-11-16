/**
 * StockFlow IoT - Modul Autentikasi & Manajemen Peran (RBAC)
 * Sesuai panduan DESIGN.md (Warm Tactile Bento Neumorphism)
 */

(() => {
  const SESSION_KEY = "stockflow_auth_session";
  const THEME_KEY = "stockflow-theme";
  const GUEST_KEY = "stockflow_guest_mode";
  const USERS_STORAGE_KEY = "stockflow_custom_users";

  // Basis data akun resmi bawaan sistem kendali IoT StockFlow
  const DEFAULT_ACCOUNTS = [
    {
      username: "admin",
      password: "admin123",
      name: "Administrator Sistem",
      role: "admin",
      roleLabel: "Administrator",
      desc: "Hak akses penuh ke seluruh kendali konveyor, kalibrasi, dan konfigurasi database.",
      isDefault: true
    },
    {
      username: "operator",
      password: "operator123",
      name: "Operator Gudang",
      role: "operator",
      roleLabel: "Operator",
      desc: "Hak akses pemantauan live, pemindaian RFID, pencatatan log, dan ekspor data.",
      isDefault: true
    }
  ];

  // Helper membaca akun kustom dari localStorage
  function getCustomAccounts() {
    try {
      const raw = localStorage.getItem(USERS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveCustomAccounts(list) {
    localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(list));
  }

  function getAllAccounts() {
    return [...DEFAULT_ACCOUNTS, ...getCustomAccounts()];
  }

  // Dapatkan URL tujuan yang aman dan memperhitungkan subdirektori (GitHub Pages /stockflow-dashboard/)
  function resolvePageUrl(filename) {
    if (window.location.protocol === "file:") return filename;
    let pathname = window.location.pathname || "/";
    if (pathname.endsWith(".html") || pathname.includes(".htm")) {
      pathname = pathname.substring(0, pathname.lastIndexOf("/") + 1);
    } else if (!pathname.endsWith("/")) {
      pathname += "/";
    }
    return window.location.origin + pathname + filename;
  }

  const StockFlowAuth = {
    resolveUrl(filename) {
      return resolvePageUrl(filename);
    },

    // Mode Tamu / Pemantau Publik (Pengunjung umum)
    isGuest() {
      return sessionStorage.getItem(GUEST_KEY) === "true";
    },

    enterGuestMode() {
      sessionStorage.setItem(GUEST_KEY, "true");
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_KEY);
      window.location.replace(resolvePageUrl("index.html"));
    },

    // Ambil daftar seluruh pengguna untuk ditampilkan di panel kelola pengguna (Admin)
    getUsers() {
      return getAllAccounts().map(u => ({
        username: u.username,
        name: u.name,
        role: u.role,
        roleLabel: u.roleLabel,
        isDefault: !!u.isDefault,
        createdAt: u.createdAt || null
      }));
    },

    // Tambah akun pengguna baru (Khusus sesi Admin)
    addUser({ username, password, name, role }) {
      if (!this.isAdmin()) {
        return {
          success: false,
          message: "Akses ditolak: Hanya Administrator yang berwenang menambahkan pengguna baru."
        };
      }

      const cleanUser = String(username || "").trim().toLowerCase();
      const cleanPass = String(password || "").trim();
      const cleanName = String(name || "").trim();
      const cleanRole = role === "admin" ? "admin" : "operator";

      if (!cleanName) {
        return { success: false, message: "Nama lengkap pengguna wajib diisi." };
      }
      if (!cleanUser || cleanUser.length < 3) {
        return { success: false, message: "Nama pengguna minimal 3 karakter." };
      }
      if (!/^[a-zA-Z0-9_.-]+$/.test(cleanUser)) {
        return {
          success: false,
          message: "Nama pengguna hanya boleh menggunakan huruf, angka, tanda titik, atau garis bawah."
        };
      }
      if (!cleanPass || cleanPass.length < 4) {
        return { success: false, message: "Kata sandi akun minimal 4 karakter." };
      }

      const all = getAllAccounts();
      if (all.some(a => a.username.toLowerCase() === cleanUser)) {
        return { success: false, message: `Nama pengguna "${cleanUser}" sudah digunakan. Gunakan nama lain.` };
      }

      const newUser = {
        username: cleanUser,
        password: cleanPass,
        name: cleanName,
        role: cleanRole,
        roleLabel: cleanRole === "admin" ? "Administrator" : "Operator",
        desc: cleanRole === "admin"
          ? "Hak akses penuh ke seluruh kendali konveyor dan konfigurasi."
          : "Hak akses pemantauan live, pemindaian RFID, dan ekspor data.",
        isDefault: false,
        createdAt: Date.now()
      };

      const customList = getCustomAccounts();
      customList.push(newUser);
      saveCustomAccounts(customList);

      return {
        success: true,
        message: `Pengguna "${cleanName}" (${cleanUser}) berhasil didaftarkan sebagai ${newUser.roleLabel}.`,
        user: newUser
      };
    },

    // Hapus akun pengguna kustom (Khusus sesi Admin)
    deleteUser(targetUsername) {
      if (!this.isAdmin()) {
        return {
          success: false,
          message: "Akses ditolak: Hanya Administrator yang berwenang menghapus akun pengguna."
        };
      }

      const cleanTarget = String(targetUsername || "").trim().toLowerCase();
      const current = this.getUser();

      if (current && current.username.toLowerCase() === cleanTarget) {
        return {
          success: false,
          message: "Anda tidak dapat menghapus akun yang sedang aktif digunakan."
        };
      }

      if (DEFAULT_ACCOUNTS.some(a => a.username.toLowerCase() === cleanTarget)) {
        return {
          success: false,
          message: "Akun bawaan sistem tidak dapat dihapus demi kelangsungan operasional."
        };
      }

      const customList = getCustomAccounts();
      const nextList = customList.filter(a => a.username.toLowerCase() !== cleanTarget);

      if (nextList.length === customList.length) {
        return { success: false, message: "Akun pengguna tidak ditemukan." };
      }

      saveCustomAccounts(nextList);
      return {
        success: true,
        message: `Akun "${cleanTarget}" berhasil dihapus dari sistem.`
      };
    },

    // Inisialisasi tema tampilan yang konsisten di semua halaman
    initTheme() {
      const saved = localStorage.getItem(THEME_KEY) || "light";
      document.documentElement.setAttribute("data-theme", saved);
      return saved;
    },

    toggleTheme() {
      const current = document.documentElement.getAttribute("data-theme") || "light";
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem(THEME_KEY, next);
      return next;
    },

    // Dapatkan data pengguna yang sedang aktif dari sesi
    getUser() {
      try {
        const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || !data.username) return null;

        // Cek kedaluwarsa sesi (7 hari untuk remember, 12 jam untuk sesi biasa)
        const now = Date.now();
        if (data.expiresAt && now > data.expiresAt) {
          this.logout(false);
          return null;
        }

        return data;
      } catch (err) {
        console.warn("Gagal membaca sesi pengguna:", err);
        return null;
      }
    },

    isAuthenticated() {
      return this.getUser() !== null;
    },

    isAdmin() {
      const user = this.getUser();
      return !!(user && user.role === "admin");
    },

    isOperator() {
      const user = this.getUser();
      return !!(user && user.role === "operator");
    },

    canControlMotor() {
      const user = this.getUser();
      return !!(user && (user.role === "admin" || user.role === "operator"));
    },

    canOperate() {
      const user = this.getUser();
      return !!(user && (user.role === "admin" || user.role === "operator"));
    },

    // Proses login kredensial
    login(username, password, remember = false) {
      const cleanUser = String(username || "").trim().toLowerCase();
      const cleanPass = String(password || "").trim();

      if (!cleanUser || !cleanPass) {
        return {
          success: false,
          message: "Nama pengguna dan kata sandi wajib diisi."
        };
      }

      const all = getAllAccounts();
      const match = all.find(
        acc => acc.username.toLowerCase() === cleanUser && acc.password === cleanPass
      );

      if (!match) {
        return {
          success: false,
          message: "Nama pengguna atau kata sandi tidak valid. Periksa kembali kredensial Anda."
        };
      }

      // Hitung masa berlaku sesi
      const now = Date.now();
      const durationMs = remember ? 7 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
      const sessionData = {
        username: match.username,
        name: match.name,
        role: match.role,
        roleLabel: match.roleLabel,
        loginAt: now,
        expiresAt: now + durationMs,
        remember: !!remember
      };

      const storage = remember ? localStorage : sessionStorage;
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(GUEST_KEY);

      storage.setItem(SESSION_KEY, JSON.stringify(sessionData));

      return {
        success: true,
        user: sessionData
      };
    },

    // Proses logout
    logout(redirect = true) {
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(GUEST_KEY);
      if (redirect) {
        window.location.href = resolvePageUrl("login.html");
      }
    },

    // Proteksi halaman dashboard (hanya bisa diakses jika sudah login atau mode tamu)
    requireAuth(redirectUrl = "login.html") {
      const user = this.getUser();
      if (user) return user;

      // Izinkan akses mode tamu
      if (this.isGuest()) {
        return {
          username: "tamu",
          name: "Mode Tamu",
          role: "guest",
          roleLabel: "Tamu",
          isGuest: true
        };
      }

      // Jika belum ada sesi dan bukan tamu, alihkan ke login
      sessionStorage.setItem("stockflow_redirect_target", window.location.href);
      window.location.replace(resolvePageUrl(redirectUrl));
      return null;
    },

    // Terapkan batasan antarmuka berdasarkan peran (RBAC) di dashboard
    applyUIPermissions() {
      const user = this.getUser();
      const isGuestMode = !user && this.isGuest();
      const isOperator = !!(user && user.role === "operator");
      const isAdmin = !!(user && user.role === "admin");

      // 1. Kendali Motor Konveyor: Bisa diakses oleh Operator dan Admin. Tamu dilarang (Read-Only).
      const motorBtnIds = ["motorStartBtn", "motorStopBtn"];
      motorBtnIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (isAdmin || isOperator) {
          el.disabled = false;
          el.removeAttribute("title");
          el.style.opacity = "1";
          el.style.cursor = "pointer";
        } else {
          el.disabled = true;
          el.setAttribute("title", "Mode Tamu bersifat Read-Only. Masuk sebagai Operator atau Admin untuk mengendalikan konveyor.");
          el.style.opacity = "0.45";
          el.style.cursor = "not-allowed";
        }
      });

      // 2. Operasional standar (Catat Log, Simulasi): Admin & Operator bisa, Tamu dilarang
      const opBtnIds = ["logWeightQuickBtn", "logWeightTableBtn", "runSimBtn", "autoSimBtn"];
      opBtnIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (isAdmin || isOperator) {
          el.disabled = false;
          el.removeAttribute("title");
          el.style.opacity = "1";
          el.style.cursor = "pointer";
        } else {
          el.disabled = true;
          el.setAttribute("title", "Mode Tamu bersifat Read-Only.");
          el.style.opacity = "0.45";
          el.style.cursor = "not-allowed";
        }
      });

      // 3. Fitur Khusus Administrator: Pengaturan & Kalibrasi Timbangan, Pergantian Mode, dan Uji Fault
      const adminOnlyIds = [
        "settingsBtn",
        "topLiveBtn",
        "topDemoBtn",
        "toggleRfidFaultBtn",
        "toggleScaleFaultBtn",
        "toggleWeakWifiBtn"
      ];

      adminOnlyIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (isAdmin) {
          el.disabled = false;
          el.removeAttribute("title");
          el.style.opacity = "1";
          el.style.cursor = "pointer";
        } else {
          el.disabled = true;
          el.setAttribute(
            "title",
            isOperator
              ? "Akses dibatasi: Hanya Administrator yang berwenang."
              : "Mode Tamu bersifat Read-Only (Hanya mode tampilan dan suara yang aktif)."
          );
          el.style.opacity = "0.45";
          el.style.cursor = "not-allowed";
        }
      });

      // 4. Tombol Kelola Pengguna: Hanya tampil untuk Admin
      const userManageBtn = document.getElementById("openUserModalBtn");
      if (userManageBtn) {
        userManageBtn.style.display = isAdmin ? "inline-flex" : "none";
      }

      // 5. Header status chip (Lencana pengguna & tombol Masuk/Keluar)
      const roleBadge = document.getElementById("userRoleBadge");
      const nameLabel = document.getElementById("userNameLabel");
      const logoutBtn = document.getElementById("logoutBtn");

      if (isGuestMode) {
        if (roleBadge) {
          roleBadge.textContent = "Tamu";
          roleBadge.className = "user-role-badge badge-guest";
        }
        if (nameLabel) {
          nameLabel.textContent = "Mode Pantau";
        }
        if (logoutBtn) {
          logoutBtn.textContent = "Masuk";
          logoutBtn.setAttribute("title", "Masuk dengan akun Admin / Operator");
          logoutBtn.onclick = () => {
            window.location.href = resolvePageUrl("login.html");
          };
        }
      } else if (user) {
        if (roleBadge) {
          roleBadge.textContent = user.roleLabel;
          roleBadge.className = "user-role-badge " + (isAdmin ? "badge-admin" : "badge-operator");
        }
        if (nameLabel) {
          nameLabel.textContent = user.name;
        }
        if (logoutBtn) {
          logoutBtn.textContent = "Keluar";
          logoutBtn.setAttribute("title", "Keluar dari sesi dashboard");
          logoutBtn.onclick = () => {
            StockFlowAuth.logout(true);
          };
        }
      }
    }
  };

  window.StockFlowAuth = StockFlowAuth;
})();
