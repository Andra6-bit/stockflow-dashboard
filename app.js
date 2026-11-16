(() => {
  const cfg = window.STOCKFLOW_CONFIG || {};
  const $ = id => document.getElementById(id);

  const createSampleLogs = () => {
    const now = Date.now();
    return [
      { UID: "E280115A", Bobot: 248.5, Timestamp: now - 45000, Status: "Valid", Produk: "Kopi Arabika Gayo", BeratStandar: 250 },
      { UID: "BEBAN-ONLY", Bobot: 172.6, Timestamp: now - 95000, Status: "Beban Saja", Produk: "Penimbangan Manual", BeratStandar: null },
      { UID: "04A1B2C3", Bobot: 318.2, Timestamp: now - 165000, Status: "Anomali", Produk: "Biji Robusta Temanggung", BeratStandar: 280 },
      { UID: "AABB1020", Bobot: 150.4, Timestamp: now - 340000, Status: "Valid", Produk: "Teh Hitam Walini", BeratStandar: 150 },
      { UID: "E28011FF", Bobot: 89.4, Timestamp: now - 580000, Status: "Reject", Produk: "Cokelat Bubuk Bali", BeratStandar: 120 },
      { UID: "91BC02D4", Bobot: 501.7, Timestamp: now - 890000, Status: "Valid", Produk: "Kopi Liberika Riau", BeratStandar: 500 },
      { UID: "7F44C901", Bobot: 253.1, Timestamp: now - 1240000, Status: "Valid", Produk: "Kopi Arabika Gayo", BeratStandar: 250 }
    ];
  };

  const loadKnnSamples = () => {
    try {
      const saved = localStorage.getItem("stockflow_knn_samples");
      if (saved) return JSON.parse(saved);
    } catch (_) {}
    return [
      { uid: "E280115A", prod: "Kopi Arabika Gayo", weight: 75.0, jalur: 0, label: "Jalur 1 (Ringan)" },
      { uid: "04A1B2C3", prod: "Biji Robusta Temanggung", weight: 250.0, jalur: 1, label: "Jalur 2 (Sedang)" },
      { uid: "AABB1020", prod: "Teh Hitam Walini", weight: 78.5, jalur: 0, label: "Jalur 1 (Ringan)" },
      { uid: "91BC02D4", prod: "Kopi Liberika Riau", weight: 260.0, jalur: 1, label: "Jalur 2 (Sedang)" }
    ];
  };

  const state = {
    mode: cfg.demoMode ? "demo" : "live",
    logs: [],
    demoLogs: createSampleLogs(),
    device: null,
    demoFaults: { rfidErr: false, scaleErr: false, weakWifi: false },
    motorRunning: false,
    motorSpeed: 255,
    scaleMode: false,
    scannedUid: "",
    knnSamples: loadKnnSamples(),
    filterStatus: "all",
    sortBy: "time",
    sortDir: "desc",
    autoStream: false,
    autoTimer: null,
    pollTimer: null,
    simBusy: false,
    soundOn: true,
    selectedPreset: { prod: "Kopi Arabika Gayo", std: 250 },
    newestKey: null,
    audioCtx: null
  };

  const safe = v => String(v ?? "-").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

  function timeValue(v) {
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }

  function fmtTime(v) {
    const n = timeValue(v);
    return n
      ? new Date(n).toLocaleString("id-ID", {
          day: "2-digit", month: "short", year: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit"
        })
      : "Waktu tidak tersedia";
  }

  function weightOf(x) {
    return Number(x.Bobot ?? x.berat ?? x.weight ?? x.weightGram ?? NaN);
  }

  function uidOf(x) {
    return x.UID ?? x.uid ?? x.rfid ?? x.tagUid ?? "UID tidak tersedia";
  }

  function productOf(x) {
    return x.Produk ?? x.produk ?? "Paket terdeteksi";
  }

  function statusOf(x) {
    const s = String(x.Status ?? x.status ?? x.klasifikasi ?? x.result ?? "").toLowerCase();
    if (["beban", "weight", "load"].some(k => s.includes(k))) return "beban";
    if (["valid", "normal", "accepted", "pass", "ok"].some(k => s.includes(k))) return "valid";
    if (["anomali", "reject", "invalid", "abnormal", "rejected"].some(k => s.includes(k))) return "reject";
    if (s.includes("test")) return "test";
    return "unknown";
  }

  function rawTime(x) {
    return timeValue(x.Timestamp ?? x.timestamp ?? x.waktu ?? x.createdAt) ?? timeValue(x.tsServer);
  }

  function labelOf(st, x) {
    const rawSt = String(x?.Status ?? x?.status ?? "").toUpperCase();
    if (rawSt.includes("JALUR 1")) return "JALUR 1 (KNN)";
    if (rawSt.includes("JALUR 2")) return "JALUR 2 (KNN)";
    return st === "valid" ? "VALID (KNN)"
      : st === "reject" ? "ANOMALI / REJECT"
      : st === "beban" ? "BEBAN SAJA"
      : st === "test" ? "SENSOR TEST"
      : "BELUM DIKETAHUI";
  }

  function normalize(raw) {
    if (!raw) return [];
    const arr = Array.isArray(raw)
      ? raw
      : Object.entries(raw).map(([key, val]) => ({ ...val, _key: key }));
    return arr
      .filter(x => x && typeof x === "object")
      .map((x, idx) => ({
        ...x,
        _id: x._key || `${uidOf(x)}-${rawTime(x) || idx}`,
        _time: rawTime(x)
      }))
      .sort((a, b) => (b._time || 0) - (a._time || 0));
  }

  /* ---------- Sound Effects (Web Audio API) ---------- */
  function playTone(freq, duration = 0.09, type = "sine", vol = 0.06, delay = 0) {
    if (!state.soundOn) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!state.audioCtx) state.audioCtx = new Ctx();
      if (state.audioCtx.state === "suspended") state.audioCtx.resume();
      const ctx = state.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime + delay;
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(vol, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    } catch {
      // Audio autoplay restrictions
    }
  }

  function sfxScan() {
    playTone(1180, 0.07, "triangle", 0.05, 0);
  }

  function sfxValid() {
    playTone(587.3, 0.11, "sine", 0.06, 0);
    playTone(880, 0.16, "sine", 0.06, 0.09);
  }

  function sfxReject() {
    playTone(260, 0.14, "sawtooth", 0.045, 0);
    playTone(195, 0.2, "sawtooth", 0.045, 0.12);
  }

  /* ---------- Toast & Connection ---------- */
  let toastTimer = null;
  function showToast(msg) {
    const t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
  }

  function setConnection(isOnline, label, sub) {
    if ($("topDot")) $("topDot").className = "status-dot" + (isOnline ? " online" : "");
    if ($("sideDot")) $("sideDot").className = "status-dot" + (isOnline ? " online" : "");
    if ($("connectionLabel")) $("connectionLabel").textContent = label;
    if ($("sideConnection")) {
      $("sideConnection").textContent =
        label === "CONNECTED" ? "Firebase terhubung"
          : label === "DEMO MODE" ? "Mode Simulasi"
          : "Belum terhubung";
    }
    if ($("sideSub")) $("sideSub").textContent = sub;
  }

  function syncModeButtons() {
    const isDemo = state.mode === "demo";
    document.body.dataset.mode = state.mode;
    if ($("topLiveBtn")) $("topLiveBtn").classList.toggle("active", !isDemo);
    if ($("topDemoBtn")) $("topDemoBtn").classList.toggle("active", isDemo);
    if ($("sideLiveBtn")) $("sideLiveBtn").classList.toggle("active", !isDemo);
    if ($("sideDemoBtn")) $("sideDemoBtn").classList.toggle("active", isDemo);
    if ($("simulator")) $("simulator").hidden = !isDemo;
    if ($("heroCta")) $("heroCta").hidden = !isDemo;
    if ($("simFaultBar")) $("simFaultBar").hidden = !isDemo;
    if ($("simModeBadge")) {
      $("simModeBadge").textContent = isDemo ? "SIMULASI AKTIF" : "NONAKTIF";
      $("simModeBadge").className = "indicator-badge-inset " + (isDemo ? "online" : "offline");
    }
    if ($("topbarSubtitle")) {
      $("topbarSubtitle").textContent = isDemo
        ? "Uji coba alur kerja konveyor, pembacaan RFID, dan sensor bobot secara interaktif."
        : "Pusat Kendali Konveyor & Pemantauan IoT";
    }
    if (isDemo && $("connectBanner")) $("connectBanner").hidden = true;
  }

  function switchMode(nextMode, silent = false) {
    if (state.mode === nextMode) return;
    state.mode = nextMode;
    if (nextMode === "live" && state.autoStream) toggleAutoStream(false);
    syncModeButtons();
    if (nextMode === "demo") {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      load();
      if (!silent) showToast("Mode Simulasi aktif. Silakan uji coba konveyor dan sensor.");
    } else {
      load();
      startPolling();
      if (!silent) showToast("Beralih ke Live Firebase.");
    }
  }

  /* ---------- Render Core ---------- */
  function animateCounter(el, target) {
    if (!el) return;
    const current = parseInt(el.textContent, 10);
    if (!Number.isFinite(current) || current === target) {
      el.textContent = target;
      return;
    }
    const diff = target - current;
    const steps = 10;
    let i = 0;
    const tick = () => {
      i++;
      el.textContent = i >= steps ? target : Math.round(current + (diff * i) / steps);
      if (i < steps) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function render() {
    const valid = state.logs.filter(x => statusOf(x) === "valid").length;
    const reject = state.logs.filter(x => statusOf(x) === "reject").length;
    const known = valid + reject;
    const weights = state.logs.map(weightOf).filter(Number.isFinite);
    const avg = weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : null;
    const minW = weights.length ? Math.min(...weights) : null;
    const maxW = weights.length ? Math.max(...weights) : null;

    animateCounter($("totalCount"), state.logs.length);
    animateCounter($("validCount"), valid);
    animateCounter($("rejectCount"), reject);

    const validPct = known ? Math.round((valid / known) * 100) : 0;
    const rejectPct = known ? Math.round((reject / known) * 100) : 0;

    if ($("validPercent")) $("validPercent").textContent = validPct + "%";
    if ($("rejectPercent")) $("rejectPercent").textContent = rejectPct + "%";
    if ($("averageWeight")) $("averageWeight").innerHTML = avg === null ? "-" : `${avg.toFixed(1)}<small> g</small>`;
    if ($("weightRangeText")) $("weightRangeText").textContent = minW !== null ? `Rentang ${minW.toFixed(0)}g - ${maxW.toFixed(0)}g` : "Rata-rata berat terukur";

    if ($("donutTotal")) $("donutTotal").textContent = state.logs.length;
    if ($("legendValid")) $("legendValid").textContent = valid;
    if ($("legendReject")) $("legendReject").textContent = reject;
    if ($("passRateText")) $("passRateText").textContent = validPct + "%";
    if ($("passRateBar")) $("passRateBar").style.width = validPct + "%";

    const pct = known ? (valid / known) * 100 : 0;
    if ($("donut")) {
      $("donut").style.background = known
        ? `conic-gradient(var(--accent-status) 0 ${pct}%, var(--accent-alert) ${pct}% 100%)`
        : `conic-gradient(var(--surface-shadow) 0 100%)`;
    }

    if ($("logCount")) $("logCount").textContent = state.logs.length + " RECORD";

    syncFilterUI();
    renderRows();
    renderChart();
    renderDevice();
  }

  function syncFilterUI() {
    if ($("statusFilter")) $("statusFilter").value = state.filterStatus;
    document.querySelectorAll(".f-pill").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.val === state.filterStatus);
    });
    document.querySelectorAll(".stat-card[data-filter]").forEach(card => {
      card.classList.toggle("active-kpi", card.dataset.filter === state.filterStatus && state.filterStatus !== "all");
    });
  }

  function setStatusFilter(val) {
    state.filterStatus = val;
    syncFilterUI();
    renderRows();
  }

  function getFilteredSortedLogs() {
    const q = ($("searchInput")?.value || "").trim().toLowerCase();
    const f = state.filterStatus;
    const list = state.logs.filter(x => {
      const hay = `${uidOf(x)} ${productOf(x)}`.toLowerCase();
      return hay.includes(q) && (f === "all" || statusOf(x) === f);
    });

    const dir = state.sortDir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      if (state.sortBy === "weight") {
        const wa = Number.isFinite(weightOf(a)) ? weightOf(a) : -Infinity;
        const wb = Number.isFinite(weightOf(b)) ? weightOf(b) : -Infinity;
        return (wa - wb) * dir;
      }
      if (state.sortBy === "status") {
        return statusOf(a).localeCompare(statusOf(b)) * dir;
      }
      return ((a._time || 0) - (b._time || 0)) * dir;
    });
  }

  function renderRows() {
    const filtered = getFilteredSortedLogs();
    if ($("showingText")) $("showingText").textContent = `Menampilkan ${filtered.length} dari ${state.logs.length} transaksi`;
    if (!filtered.length) {
      if ($("logBody")) $("logBody").innerHTML = '<tr><td colspan="4" style="text-align:center; padding:32px; color:var(--ink-muted);">Tidak ada transaksi yang cocok.</td></tr>';
      return;
    }

    if ($("logBody")) {
      $("logBody").innerHTML = filtered.map(x => {
        const st = statusOf(x);
        const label = labelOf(st, x);
        const w = weightOf(x);
        const isNew = state.newestKey && x._id === state.newestKey;
        return `<tr class="log-row ${isNew ? "row-new" : ""}" data-id="${safe(x._id)}">
          <td>${safe(uidOf(x))}<span class="uid-sub">${safe(productOf(x))}</span></td>
          <td><span class="weight tabular">${Number.isFinite(w) ? w.toFixed(1) + " g" : "-"}</span></td>
          <td><span class="pill ${st === "valid" ? "valid" : st === "reject" ? "reject" : st === "beban" ? "beban" : ""}">${label}</span></td>
          <td>${safe(fmtTime(x._time ?? x.Timestamp))}</td>
        </tr>`;
      }).join("");
    }
  }

  /* ---------- Interactive SVG Weight Chart ---------- */
  function renderChart() {
    const svg = $("weightChart");
    const tooltip = $("chartTooltip");
    if (!svg || !tooltip) return;
    tooltip.hidden = true;

    const recent = state.logs
      .filter(x => Number.isFinite(weightOf(x)))
      .slice(0, 14)
      .reverse();

    if (!recent.length) {
      svg.innerHTML = `<text x="320" y="90" text-anchor="middle" fill="var(--ink-muted)" font-size="12">Belum ada data bobot untuk ditampilkan</text>`;
      return;
    }

    const W = 640, H = 170, padL = 38, padR = 16, padT = 18, padB = 26;
    const weights = recent.map(weightOf);
    const minW = Math.max(0, Math.floor((Math.min(...weights) - 40) / 25) * 25);
    const maxW = Math.ceil((Math.max(...weights) + 40) / 25) * 25 || 600;
    const span = Math.max(50, maxW - minW);

    const xAt = i => recent.length === 1
      ? (W - padL - padR) / 2 + padL
      : padL + (i / (recent.length - 1)) * (W - padL - padR);
    const yAt = w => padT + (1 - (w - minW) / span) * (H - padT - padB);

    const gridLines = [0, 0.5, 1].map(r => {
      const val = Math.round(minW + span * (1 - r));
      const y = padT + r * (H - padT - padB);
      return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--surface-shadow)" stroke-dasharray="4 4"/>
              <text x="${padL - 6}" y="${y + 4}" text-anchor="end" fill="var(--ink-muted)" font-size="10" font-family="Plus Jakarta Sans">${val}g</text>`;
    }).join("");

    const pts = recent.map((item, i) => {
      const w = weightOf(item);
      return { x: xAt(i), y: yAt(w), w, item };
    });

    const polyPoints = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const areaPoints = `${pts[0].x.toFixed(1)},${H - padB} ${polyPoints} ${pts[pts.length - 1].x.toFixed(1)},${H - padB}`;

    const dots = pts.map((p, idx) => {
      const st = statusOf(p.item);
      const color = st === "valid" ? "var(--accent-status)" : st === "reject" ? "var(--accent-alert)" : "var(--accent-cta)";
      return `<g class="chart-pt" data-idx="${idx}" style="cursor:pointer">
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="10" fill="transparent"/>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="${color}" stroke="var(--surface)" stroke-width="2"/>
      </g>`;
    }).join("");

    svg.innerHTML = `
      <defs>
        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#9E5834" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#9E5834" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <polygon points="${areaPoints}" fill="url(#chartGrad)"/>
      <polyline points="${polyPoints}" fill="none" stroke="#9E5834" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
    `;

    svg.querySelectorAll(".chart-pt").forEach(node => {
      const item = recent[Number(node.dataset.idx)];
      node.addEventListener("mouseenter", () => {
        const rect = svg.getBoundingClientRect();
        const wrapRect = $("chartWrap").getBoundingClientRect();
        const pt = pts[Number(node.dataset.idx)];
        const left = ((pt.x / W) * rect.width) + (rect.left - wrapRect.left);
        const top = ((pt.y / H) * rect.height) + (rect.top - wrapRect.top);
        const st = labelOf(statusOf(item));
        tooltip.innerHTML = `<strong>${safe(uidOf(item))}</strong> · ${safe(productOf(item))}<br>${pt.w.toFixed(1)} g · <b>${st}</b>`;
        tooltip.style.left = `${Math.max(70, Math.min(wrapRect.width - 70, left))}px`;
        tooltip.style.top = `${Math.max(36, top)}px`;
        tooltip.hidden = false;
      });
      node.addEventListener("mouseleave", () => { tooltip.hidden = true; });
      node.addEventListener("click", () => openDetailModal(item));
    });
  }

  /* ---------- Device Telemetry ---------- */
  function renderDevice() {
    const dev = state.mode === "demo"
      ? {
          lastSeenMs: Date.now(),
          rfidOk: !state.demoFaults.rfidErr,
          hx711Ok: !state.demoFaults.scaleErr,
          servoOk: true,
          servoState: "standby",
          servoAngle: 90,
          weightGram: 0,
          rssi: state.demoFaults.weakWifi ? -85 : -56
        }
      : state.device;

    const seen = dev ? (timeValue(dev.lastSeenMs) ?? timeValue(dev.lastSeen ?? dev.timestamp ?? dev.Timestamp)) : null;
    const age = seen ? Date.now() - seen : Infinity;
    const online = age < (state.mode === "demo" ? 60000 : 20000);

    if ($("deviceBadge")) {
      $("deviceBadge").className = "indicator-badge-inset " + (online ? "online" : dev ? "offline" : "");
      $("deviceBadge").textContent = state.mode === "demo"
        ? (online ? "SIMULASI ONLINE" : "SIMULASI OFFLINE")
        : (online ? "PERANGKAT ONLINE" : dev ? "PERANGKAT OFFLINE" : "BELUM TERHUBUNG");
    }

    if ($("espState")) {
      $("espState").textContent = online ? "Terhubung" : dev ? "Tidak aktif" : "Belum ada heartbeat";
      $("espState").style.color = online ? "var(--accent-status)" : dev ? "var(--accent-alert)" : "var(--ink-body)";
    }
    if ($("lastSeen")) {
      $("lastSeen").textContent = dev && seen
        ? `Terakhir terlihat: ${fmtTime(seen)}`
        : "Status telemetri sensor dan mikrokontroler.";
    }

    const live = online ? dev : null;

    const sensor = (key, stateId, detailId, title) => {
      const val = live?.[key];
      const good = val === true || String(val).toLowerCase() === "ok" || String(val).toLowerCase() === "true";
      if ($(stateId)) {
        $(stateId).textContent = val === undefined ? "Tidak diketahui" : good ? "Online" : "Tidak terdeteksi";
        $(stateId).style.color = val === undefined ? "var(--ink-body)" : good ? "var(--accent-status)" : "var(--accent-alert)";
      }
      if ($(detailId)) {
        $(detailId).textContent = val === undefined ? "Status belum dikirim" : good ? title + " terdeteksi" : "Periksa suplai atau kabel";
      }
    };

    sensor("rfidOk", "rfidState", "rfidDetail", "RFID RC522");
    sensor("hx711Ok", "scaleState", "scaleDetail", "Load Cell / HX711");

    // Berat live
    const wg = Number(live?.weightGram);
    if ($("liveWeight")) $("liveWeight").textContent = Number.isFinite(wg) ? `${wg.toFixed(1)} g` : "-";
    if ($("liveWeightDetail")) {
      $("liveWeightDetail").textContent = live
        ? `Nilai raw ${live.weightRaw ?? "-"} · UID terakhir: ${live.lastUID && live.lastUID !== "-" ? live.lastUID : "belum ada"}`
        : "Menunggu data timbangan dari sensor Load Cell HX711.";
    }

    // Servo
    const sv = live?.servoOk;
    const svState = String(live?.servoState || "").toLowerCase();
    if ($("servoState")) {
      $("servoState").textContent = sv === undefined ? "Tidak diketahui"
        : sv === false ? "Tidak terdeteksi"
        : svState === "standby" ? "Standby"
        : svState ? svState.charAt(0).toUpperCase() + svState.slice(1) : "Online";
      $("servoState").style.color = sv === undefined ? "var(--ink-body)" : sv ? "var(--accent-status)" : "var(--accent-alert)";
    }
    if ($("servoDetail")) {
      $("servoDetail").textContent = live && live.servoAngle !== undefined ? `Posisi sudut ${live.servoAngle}°` : "Pintu pemilah jalur paket";
    }

    // Wi-Fi RSSI
    const rssi = live ? (live.rssi ?? live.wifiRssi) : undefined;
    if ($("wifiState")) $("wifiState").textContent = rssi === undefined ? "Tidak diketahui" : `${rssi} dBm`;
    if ($("wifiDetail")) {
      $("wifiDetail").textContent = rssi === undefined
        ? "Konektivitas nirkabel lokal"
        : rssi > -67 ? "Sinyal baik"
        : rssi > -80 ? "Sinyal cukup"
        : "Sinyal lemah";
    }

    const bars = $("wifiBars");
    if (bars) {
      bars.className = "wifi-bars";
      if (typeof rssi === "number") {
        if (rssi > -60) bars.classList.add("lvl-4");
        else if (rssi > -70) bars.classList.add("lvl-3");
        else if (rssi > -82) bars.classList.add("lvl-2");
        else bars.classList.add("lvl-1");
      }
    }

    // Motor Konveyor
    const motorRun = live?.motorRunning ?? (state.mode === "demo" ? state.motorRunning : false);
    const motorSpd = live?.motorSpeed ?? (state.mode === "demo" ? state.motorSpeed : 0);
    const mBadge = $("motorBadge");
    const mText = $("motorStatusText");
    const mState = $("espMotorState");
    const mDetail = $("espMotorDetail");

    // Status Mode Timbangan & Kalibrasi Digital
    const isScaleMode = Boolean(live?.scaleMode ?? state.scaleMode);
    state.scaleMode = isScaleMode;
    if ($("scaleModeBadge")) {
      $("scaleModeBadge").style.display = isScaleMode ? "inline-block" : "none";
    }
    if ($("scaleModeHeading")) {
      $("scaleModeHeading").textContent = isScaleMode ? "Status: Mode Timbangan Aktif" : "Status: Mode Konveyor Normal";
    }
    if ($("scaleModeSub")) {
      $("scaleModeSub").textContent = isScaleMode
        ? "Dinamo motor dikunci mati demi akurasi penimbangan statis."
        : "Aktifkan mode timbangan untuk mematikan dinamo dan mengukur bobot secara statis.";
    }
    if ($("toggleScaleModeBtn")) {
      $("toggleScaleModeBtn").textContent = isScaleMode ? "Matikan Mode Timbangan" : "Aktifkan Mode Timbangan";
      $("toggleScaleModeBtn").className = isScaleMode ? "btn-cta btn-cta-danger" : "btn-cta btn-cta-primary";
    }

    if (mBadge) {
      mBadge.textContent = isScaleMode
        ? "MODE TIMBANGAN AKTIF"
        : (!online && state.mode !== "demo" ? "PERANGKAT OFFLINE" : (motorRun ? "MOTOR BERJALAN" : "MOTOR BERHENTI"));
      mBadge.className = "indicator-badge-inset " + (isScaleMode ? "offline" : (online || state.mode === "demo" ? (motorRun ? "online" : "offline") : ""));
    }
    if (mText) {
      mText.textContent = isScaleMode
        ? "Mode Timbangan Digital aktif. Dinamo motor dikunci mati demi keselamatan & akurasi timbangan."
        : (motorRun
          ? `Dinamo konveyor sedang berjalan aktif (Kecepatan PWM ${motorSpd || 255}).`
          : "Dinamo konveyor dalam posisi berhenti (STOP).");
    }
    if (mState) {
      mState.textContent = live === null ? "Tidak diketahui" : (isScaleMode ? "Terkunci (Mode Timbangan)" : (motorRun ? "Berjalan (ON)" : "Berhenti (OFF)"));
      mState.style.color = live === null ? "var(--ink-body)" : (isScaleMode ? "var(--accent-alert)" : (motorRun ? "var(--accent-status)" : "var(--accent-alert)"));
    }
    if (mDetail) {
      mDetail.textContent = live === null ? "Penggerak mekanik konveyor" : (isScaleMode ? "Motor di-lock OFF" : `Kecepatan PWM: ${motorSpd}`);
    }

    if ($("scaleLiveWeight")) {
      $("scaleLiveWeight").textContent = Number.isFinite(wg) ? `${wg.toFixed(1)} g` : "0.0 g";
    }

    const lastScanned = live?.lastScannedUID ?? live?.lastUID;
    if (lastScanned && lastScanned !== "-" && lastScanned !== state.scannedUid) {
      state.scannedUid = lastScanned;
      if ($("scaleScannedUid")) {
        $("scaleScannedUid").textContent = lastScanned;
      }
      if ($("scaleUidStatus")) {
        const existing = state.knnSamples.find(s => s.uid.toUpperCase() === lastScanned.toUpperCase());
        if (existing) {
          $("scaleUidStatus").textContent = `Terdaftar: ${existing.prod} (${existing.weight}g · ${existing.label})`;
          $("scaleUidStatus").style.color = "var(--accent-status)";
          if ($("scaleProdNameInput") && !$("scaleProdNameInput").value) {
            $("scaleProdNameInput").value = existing.prod;
          }
          if ($("scaleJalurSelect")) {
            $("scaleJalurSelect").value = String(existing.jalur);
          }
        } else {
          $("scaleUidStatus").textContent = "Tag baru terdeteksi! Siap didaftarkan.";
          $("scaleUidStatus").style.color = "var(--accent-primary)";
        }
      }
    }
  }

  /* ---------- Firebase Fetch & Write ---------- */
  function dbUrl(path) {
    if (!cfg.databaseURL) throw new Error("databaseURL belum diisi di config.js");
    const base = cfg.databaseURL.replace(/\/$/, "") + "/" + path.replace(/^\//, "") + ".json";
    return base + (cfg.authToken ? "?auth=" + encodeURIComponent(cfg.authToken) : "");
  }

  async function getFirebase(path) {
    const res = await fetch(dbUrl(path), { cache: "no-store" });
    if (!res.ok) throw new Error(`Firebase HTTP ${res.status}`);
    return res.json();
  }

  async function patchFirebase(path, data) {
    const res = await fetch(dbUrl(path), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Firebase PATCH HTTP ${res.status}`);
    return res.json();
  }

  async function postFirebase(path, data) {
    const res = await fetch(dbUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Firebase POST HTTP ${res.status}`);
    return res.json();
  }

  /* ---------- Hardware Control (Motor Dinamo & Log Beban) ---------- */
  function updateMotorUI(isRunning, speed = 255) {
    state.motorRunning = isRunning;
    state.motorSpeed = speed;
    const badge = $("motorBadge");
    const text = $("motorStatusText");
    const mState = $("espMotorState");
    const mDetail = $("espMotorDetail");

    if (badge) {
      badge.textContent = isRunning ? "MOTOR BERJALAN" : "MOTOR BERHENTI";
      badge.className = "indicator-badge-inset " + (isRunning ? "online" : "offline");
    }
    if (text) {
      text.textContent = isRunning
        ? `Dinamo konveyor sedang berjalan aktif (Kecepatan PWM ${speed}).`
        : "Dinamo konveyor dalam posisi berhenti (STOP).";
    }
    if (mState) {
      mState.textContent = isRunning ? "Berjalan (ON)" : "Berhenti (OFF)";
      mState.style.color = isRunning ? "var(--accent-status)" : "var(--accent-alert)";
    }
    if (mDetail) {
      mDetail.textContent = isRunning ? `Kecepatan PWM: ${speed}` : "Standby";
    }
  }

  async function setConveyorMotor(shouldRun, speed = 255) {
    if (window.StockFlowAuth && !window.StockFlowAuth.isAdmin()) {
      showToast("Aksi dibatasi: Hanya Administrator yang berwenang mengendalikan motor.");
      return;
    }

    updateMotorUI(shouldRun, speed);

    if (state.mode === "demo") {
      const belt = document.querySelector(".belt-track");
      if (belt) belt.classList.toggle("running", shouldRun);
      showToast(shouldRun ? "Dinamo konveyor dijalankan (Mode Simulasi)" : "Dinamo konveyor dihentikan (Mode Simulasi)");
      return;
    }

    try {
      await patchFirebase("device/status/control", {
        motor: shouldRun,
        speed: speed,
        command: shouldRun ? "run" : "stop",
        updatedAt: { ".sv": "timestamp" }
      });
      await patchFirebase("device/status", {
        motorRunning: shouldRun,
        motorSpeed: speed
      });
      showToast(shouldRun ? "Perintah RUN terkirim ke ESP8266" : "Perintah STOP terkirim ke ESP8266");
      setTimeout(load, 800);
    } catch (e) {
      showToast("Gagal mengirim perintah motor: " + e.message);
    }
  }

  async function logWeightOnly() {
    let weight = Number(state.device?.weightGram);
    if (!Number.isFinite(weight) || weight <= 0) {
      if (state.mode === "demo") {
        weight = Number($("simWeightSlider")?.value) || 250.0;
      } else {
        const input = prompt("Timbangan membaca 0.0g atau menunggu data. Masukkan nilai bobot (gram) yang ingin dicatat:", "150.0");
        if (input === null) return;
        weight = parseFloat(input);
        if (isNaN(weight) || weight <= 0) {
          showToast("Nilai bobot tidak valid");
          return;
        }
      }
    }

    const item = {
      UID: "BEBAN-ONLY",
      Produk: "Penimbangan Manual",
      Bobot: Number(weight.toFixed(1)),
      Status: "Beban Saja",
      Timestamp: new Date().toISOString()
    };

    if (state.mode === "demo") {
      state.demoLogs.unshift({
        ...item,
        Timestamp: Date.now()
      });
      if (state.demoLogs.length > 60) state.demoLogs.pop();
      state.logs = normalize(state.demoLogs);
      state.newestKey = state.logs[0]?._id || null;
      render();
      showToast(`Log bobot berhasil dicatat: ${weight.toFixed(1)} g`);
      return;
    }

    try {
      await postFirebase("logs", {
        ...item,
        weightRaw: state.device?.weightRaw ?? 0,
        servoAngle: 90,
        tsServer: { ".sv": "timestamp" }
      });
      showToast(`Log bobot disimpan ke Firebase: ${weight.toFixed(1)} g`);
      await load();
    } catch (e) {
      showToast("Gagal menyimpan log bobot: " + e.message);
    }
  }

  async function load() {
    if (state.mode === "demo") {
      state.logs = normalize(state.demoLogs);
      setConnection(true, "DEMO MODE", "Playground simulasi aktif");
      syncModeButtons();
      render();
      return;
    }

    try {
      const [raw, stat] = await Promise.all([getFirebase("logs"), getFirebase("device/status")]);
      state.logs = normalize(raw);
      state.device = stat || null;
      setConnection(true, "CONNECTED", "Sinkronisasi Firebase berhasil");
      if ($("connectBanner")) $("connectBanner").hidden = state.logs.length > 0;
      if (!state.logs.length && $("bannerTitle")) {
        $("bannerTitle").textContent = "Firebase terhubung, log transaksi masih kosong";
        $("bannerDesc").textContent = "Menunggu data dari ESP8266. Anda dapat menguji dashboard melalui Mode Simulasi.";
      }
      render();
    } catch (e) {
      setConnection(false, "DISCONNECTED", e.message);
      if ($("connectBanner")) {
        $("connectBanner").hidden = false;
        $("bannerTitle").textContent = `Koneksi Firebase terputus (${e.message})`;
        $("bannerDesc").textContent = "Gunakan Mode Simulasi untuk tetap menguji visualisasi dan fitur pemantauan.";
      }
      render();
    }
  }

  function startPolling() {
    clearInterval(state.pollTimer);
    if (state.mode === "live" && cfg.databaseURL && !cfg.databaseURL.includes("NAMA-PROJECT")) {
      state.pollTimer = setInterval(load, Math.max(3000, Number(cfg.pollIntervalMs) || 5000));
    }
  }

  /* ---------- Interactive Conveyor Simulator ---------- */
  const randomUid = () => Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()).join("");

  function spawnBurst(color) {
    const layer = $("burstLayer");
    if (!layer) return;
    for (let i = 0; i < 14; i++) {
      const dot = document.createElement("span");
      dot.className = "burst-dot";
      const angle = (Math.PI * 2 * i) / 14;
      const dist = 26 + Math.random() * 38;
      dot.style.left = "80%";
      dot.style.top = "50%";
      dot.style.background = color;
      dot.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
      dot.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
      layer.appendChild(dot);
      setTimeout(() => dot.remove(), 760);
    }
  }

  function updateWeightHint() {
    if (!$("simWeightSlider")) return;
    const w = Number($("simWeightSlider").value);
    const std = state.selectedPreset.std;
    const diff = w - std;
    const sign = diff >= 0 ? "+" : "";
    const ok = Math.abs(diff) <= 15;
    if ($("simWeightLabel")) $("simWeightLabel").textContent = `${w.toFixed(1)} g`;
    if ($("simDiffHint")) {
      $("simDiffHint").textContent = `(Standar ${std}g · Selisih ${sign}${diff.toFixed(1)}g · ${ok ? "Dalam toleransi" : "Di luar toleransi"})`;
      $("simDiffHint").style.color = ok ? "var(--accent-status)" : "var(--accent-alert)";
    }
    if ($("pkgVisualUid")) $("pkgVisualUid").textContent = $("simUidInput")?.value.trim().toUpperCase() || "E280115A";
    if ($("pkgVisualProd")) $("pkgVisualProd").textContent = state.selectedPreset.prod;
  }

  function runPackageSimulation(customPacket = null) {
    if (state.simBusy) return;
    if (state.mode !== "demo") {
      switchMode("demo", true);
      showToast("Beralih ke Mode Simulasi.");
    }

    state.simBusy = true;
    const uid = (customPacket?.UID || $("simUidInput")?.value.trim() || randomUid()).toUpperCase();
    const prod = customPacket?.Produk || state.selectedPreset.prod;
    const std = customPacket?.BeratStandar || state.selectedPreset.std;
    const weight = customPacket?.Bobot ?? Number($("simWeightSlider")?.value || 250);

    const pkg = $("simPackage");
    const belt = document.querySelector(".belt-track");
    const stRfid = $("stationRfid");
    const stScale = $("stationScale");
    const stGate = $("stationGate");
    const lcd = $("lcdScreen");
    const gateArm = $("gateArm");
    const gateResult = $("gateResult");

    if ($("pkgVisualUid")) $("pkgVisualUid").textContent = uid;
    if ($("pkgVisualProd")) $("pkgVisualProd").textContent = prod;

    if (pkg) pkg.className = "sim-package";
    if (gateArm) gateArm.className = "gate-arm";
    if (stRfid) stRfid.classList.remove("lit");
    if (stScale) stScale.classList.remove("lit");
    if (stGate) stGate.classList.remove("lit-ok", "lit-err");
    if (belt) belt.classList.add("running");

    // Langkah 1: Pindai RFID
    setTimeout(() => {
      if (pkg) pkg.classList.add("at-rfid");
      if (stRfid) stRfid.classList.add("lit");
      if ($("rfidLed")) $("rfidLed").classList.add("scanning");
      if ($("rfidReadout")) $("rfidReadout").textContent = state.demoFaults.rfidErr ? "ERROR BACA" : uid;
      sfxScan();
    }, 80);

    // Langkah 2: Penimbangan Load Cell
    let jitterTimer = null;
    setTimeout(() => {
      if (stRfid) stRfid.classList.remove("lit");
      if ($("rfidLed")) $("rfidLed").classList.remove("scanning");
      if (pkg) pkg.classList.add("at-scale");
      if (stScale) stScale.classList.add("lit");

      let ticks = 0;
      jitterTimer = setInterval(() => {
        ticks++;
        if (state.demoFaults.scaleErr) {
          if (lcd) lcd.textContent = "ERR HX711";
        } else {
          const wobble = (Math.random() - 0.5) * 8;
          if (lcd) lcd.textContent = `${Math.max(0, weight + wobble).toFixed(1)} g`;
        }
        if (ticks >= 7) {
          clearInterval(jitterTimer);
          if (lcd) lcd.textContent = state.demoFaults.scaleErr ? "0.0 g" : `${weight.toFixed(1)} g`;
        }
      }, 65);
    }, 560);

    // Langkah 3: Evaluasi Servo Diverter & Catat Transaksi
    setTimeout(() => {
      clearInterval(jitterTimer);
      if (stScale) stScale.classList.remove("lit");

      const finalWeight = state.demoFaults.scaleErr ? 0 : weight;
      const isValid = !state.demoFaults.rfidErr && !state.demoFaults.scaleErr && Math.abs(finalWeight - std) <= 15;
      const statusStr = isValid ? "Valid" : "Anomali";

      if (pkg) pkg.classList.add(isValid ? "at-gate-valid" : "at-gate-reject");
      if (gateArm) gateArm.classList.add(isValid ? "valid" : "reject");
      if (stGate) stGate.classList.add(isValid ? "lit-ok" : "lit-err");
      if (gateResult) {
        gateResult.textContent = isValid ? "JALUR VALID" : "JALUR REJECT";
        gateResult.style.color = isValid ? "var(--accent-status)" : "var(--accent-alert)";
      }

      if (isValid) {
        sfxValid();
        spawnBurst("#4D6B53");
      } else {
        sfxReject();
        spawnBurst("#A84338");
      }

      const record = {
        UID: uid,
        Bobot: Number(finalWeight.toFixed(1)),
        Timestamp: Date.now(),
        Status: statusStr,
        Produk: prod,
        BeratStandar: std
      };

      state.demoLogs.unshift(record);
      if (state.demoLogs.length > 60) state.demoLogs.pop();
      state.logs = normalize(state.demoLogs);
      state.newestKey = state.logs[0]?._id || null;
      render();
      showToast(`${uid} (${finalWeight.toFixed(1)}g) → ${isValid ? "VALID" : "ANOMALI / REJECT"}`);
    }, 1180);

    // Reset posisi
    setTimeout(() => {
      if (belt) belt.classList.remove("running");
      if (pkg) pkg.className = "sim-package";
      if ($("rfidReadout")) $("rfidReadout").textContent = "SIAP PINDAI";
      state.simBusy = false;
    }, 1900);
  }

  function spawnRandomSimulation() {
    const catalog = [
      { prod: "Kopi Arabika Gayo", std: 250 },
      { prod: "Biji Robusta Temanggung", std: 280 },
      { prod: "Teh Hitam Walini", std: 150 },
      { prod: "Kopi Liberika Riau", std: 500 }
    ];
    const pick = catalog[Math.floor(Math.random() * catalog.length)];
    const makeAnomaly = Math.random() < 0.28;
    const offset = makeAnomaly
      ? (Math.random() < 0.5 ? -1 : 1) * (24 + Math.random() * 45)
      : (Math.random() - 0.5) * 14;
    const bobot = Math.max(25, Number((pick.std + offset).toFixed(1)));
    const uid = randomUid();

    if ($("simUidInput")) $("simUidInput").value = uid;
    state.selectedPreset = pick;
    if ($("simWeightSlider")) $("simWeightSlider").value = bobot;
    updateWeightHint();

    runPackageSimulation({
      UID: uid,
      Produk: pick.prod,
      BeratStandar: pick.std,
      Bobot: bobot
    });
  }

  function toggleAutoStream(force) {
    const next = typeof force === "boolean" ? force : !state.autoStream;
    state.autoStream = next;
    clearInterval(state.autoTimer);

    const btn = $("autoSimBtn");
    const heroBtn = $("heroAutoBtn");
    if (btn) {
      btn.classList.toggle("active", next);
      btn.textContent = next ? "Hentikan Stream" : "Auto Stream";
    }
    if (heroBtn) {
      heroBtn.classList.toggle("active", next);
      heroBtn.textContent = next ? "Hentikan Auto" : "Auto Conveyor";
    }

    if (next) {
      if (state.mode !== "demo") switchMode("demo", true);
      spawnRandomSimulation();
      state.autoTimer = setInterval(() => {
        if (!state.simBusy) spawnRandomSimulation();
      }, 2500);
      showToast("Auto Conveyor aktif. Paket diproses otomatis.");
    }
  }

  /* ---------- Modal Inspector & CSV ---------- */
  function openDetailModal(item) {
    const w = weightOf(item);
    const std = Number(item.BeratStandar ?? item.beratStandar ?? NaN);
    const st = statusOf(item);
    const diff = Number.isFinite(w) && Number.isFinite(std) ? w - std : null;
    const label = labelOf(st);

    if ($("modalTitle")) $("modalTitle").textContent = `Detail Paket: ${uidOf(item)}`;
    if ($("modalBody")) {
      $("modalBody").innerHTML = `
        <div class="modal-grid">
          <div class="m-stat"><small>UID RFID</small><b>${safe(uidOf(item))}</b></div>
          <div class="m-stat"><small>Produk</small><b>${safe(productOf(item))}</b></div>
          <div class="m-stat"><small>Bobot Aktual</small><b class="tabular">${Number.isFinite(w) ? w.toFixed(1) + " g" : "-"}</b></div>
          <div class="m-stat"><small>Hasil Klasifikasi</small><span class="pill ${st === "valid" ? "valid" : st === "reject" ? "reject" : ""}">${label}</span></div>
          <div class="m-stat"><small>Bobot Standar</small><b class="tabular">${Number.isFinite(std) ? std.toFixed(1) + " g" : "Tidak dicatat"}</b></div>
          <div class="m-stat"><small>Selisih</small><b class="tabular" style="color:${diff === null ? "var(--ink-body)" : Math.abs(diff) <= 15 ? "var(--accent-status)" : "var(--accent-alert)"}">${diff === null ? "-" : (diff >= 0 ? "+" : "") + diff.toFixed(1) + " g"}</b></div>
        </div>
        <div class="m-stat" style="margin-bottom:14px;"><small>Waktu Transaksi</small><b>${safe(fmtTime(item._time ?? item.Timestamp))}</b></div>
        <pre class="modal-json">${safe(JSON.stringify({
          UID: uidOf(item),
          Produk: productOf(item),
          Bobot: Number.isFinite(w) ? w : null,
          BeratStandar: Number.isFinite(std) ? std : undefined,
          Status: item.Status ?? item.status ?? label,
          Timestamp: item.Timestamp ?? item.timestamp ?? item.waktu ?? item.createdAt
        }, null, 2))}</pre>
        <div class="modal-actions">
          <button type="button" class="btn-util" id="copyUidBtn">Salin UID</button>
          <button type="button" class="btn-cta btn-cta-primary" id="modalDoneBtn">Tutup</button>
        </div>
      `;
    }

    if ($("detailModal")) {
      $("detailModal").hidden = false;
      $("detailModal").setAttribute("aria-hidden", "false");
    }

    const copyBtn = $("copyUidBtn");
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(String(uidOf(item)));
          showToast("UID disalin ke clipboard");
        } catch {
          showToast("Gagal menyalin UID");
        }
      };
    }

    const doneBtn = $("modalDoneBtn");
    if (doneBtn) doneBtn.onclick = closeDetailModal;
  }

  function closeDetailModal() {
    if ($("detailModal")) {
      $("detailModal").hidden = true;
      $("detailModal").setAttribute("aria-hidden", "true");
    }
  }

  function exportCsv() {
    const rows = getFilteredSortedLogs();
    if (!rows.length) {
      showToast("Tidak ada data untuk diekspor");
      return;
    }
    const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      ["UID", "Produk", "Berat_Gram", "Status", "Waktu"].join(","),
      ...rows.map(x => [
        esc(uidOf(x)),
        esc(productOf(x)),
        Number.isFinite(weightOf(x)) ? weightOf(x).toFixed(1) : "",
        esc(statusOf(x).toUpperCase()),
        esc(fmtTime(x._time ?? x.Timestamp))
      ].join(","))
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stockflow-logs.csv";
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Berhasil mengunduh ${rows.length} record CSV`);
  }

  /* ---------- Theme & Navigation ---------- */
  function initTheme() {
    const saved = localStorage.getItem("stockflow-theme") || "light";
    applyTheme(saved);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    if ($("themeBtn")) {
      $("themeBtn").textContent = theme === "dark" ? "Mode Terang" : "Mode Gelap";
      $("themeBtn").setAttribute("aria-pressed", String(theme === "dark"));
    }
    localStorage.setItem("stockflow-theme", theme);
  }

  function setActiveNav(sectionId) {
    document.querySelectorAll(".nav, .m-pill").forEach(el => {
      el.classList.toggle("active", el.dataset.section === sectionId);
    });
  }

  /* ---------- Event Listeners ---------- */
  $("topLiveBtn")?.addEventListener("click", () => switchMode("live"));
  $("sideLiveBtn")?.addEventListener("click", () => switchMode("live"));
  $("topDemoBtn")?.addEventListener("click", () => switchMode("demo"));
  $("sideDemoBtn")?.addEventListener("click", () => switchMode("demo"));
  $("bannerSimBtn")?.addEventListener("click", () => switchMode("demo"));

  $("refreshBtn")?.addEventListener("click", () => {
    load();
    showToast("Memperbarui data...");
  });

  $("soundBtn")?.addEventListener("click", () => {
    state.soundOn = !state.soundOn;
    $("soundBtn").textContent = state.soundOn ? "Suara: ON" : "Suara: OFF";
    $("soundBtn").setAttribute("aria-pressed", String(state.soundOn));
    if (state.soundOn) sfxScan();
    showToast(state.soundOn ? "Efek suara aktif" : "Efek suara dimatikan");
  });

  $("themeBtn")?.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    applyTheme(current === "dark" ? "light" : "dark");
  });

  $("heroArt")?.addEventListener("click", () => {
    sfxScan();
    showToast("Pusat sensor StockFlow aktif.");
  });

  $("heroQuickScanBtn")?.addEventListener("click", () => {
    $("simulator")?.scrollIntoView({ behavior: "smooth", block: "center" });
    spawnRandomSimulation();
  });

  $("heroAutoBtn")?.addEventListener("click", () => toggleAutoStream());
  $("autoSimBtn")?.addEventListener("click", () => toggleAutoStream());
  $("runSimBtn")?.addEventListener("click", () => runPackageSimulation());

  $("randomUidBtn")?.addEventListener("click", () => {
    if ($("simUidInput")) $("simUidInput").value = randomUid();
    updateWeightHint();
    sfxScan();
  });

  $("simUidInput")?.addEventListener("input", updateWeightHint);
  $("simWeightSlider")?.addEventListener("input", updateWeightHint);

  document.querySelectorAll(".chip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".chip-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.selectedPreset = {
        prod: btn.dataset.prod,
        std: Number(btn.dataset.std)
      };
      if ($("simWeightSlider")) $("simWeightSlider").value = btn.dataset.weight;
      if ($("simUidInput")) $("simUidInput").value = randomUid();
      updateWeightHint();
    });
  });

  $("resetDemoBtn")?.addEventListener("click", () => {
    toggleAutoStream(false);
    state.demoFaults = { rfidErr: false, scaleErr: false, weakWifi: false };
    document.querySelectorAll(".btn-util").forEach(b => b.classList.remove("active"));
    state.demoLogs = createSampleLogs();
    state.newestKey = null;
    if (state.mode !== "demo") switchMode("demo", true);
    else load();
    showToast("Data simulasi dikembalikan ke awal");
  });

  $("searchInput")?.addEventListener("input", renderRows);
  $("statusFilter")?.addEventListener("change", e => setStatusFilter(e.target.value));
  document.querySelectorAll(".f-pill").forEach(btn => {
    btn.addEventListener("click", () => setStatusFilter(btn.dataset.val));
  });
  document.querySelectorAll(".stat-card[data-filter], .legend-item[data-filter]").forEach(el => {
    el.addEventListener("click", () => setStatusFilter(el.dataset.filter));
  });

  $("donut")?.addEventListener("click", () => {
    const order = ["all", "valid", "reject"];
    const next = order[(order.indexOf(state.filterStatus) + 1) % order.length];
    setStatusFilter(next);
  });

  document.querySelectorAll("th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (state.sortBy === col) state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
      else { state.sortBy = col; state.sortDir = "desc"; }
      document.querySelectorAll("th.sortable").forEach(h => h.classList.remove("active-sort"));
      th.classList.add("active-sort");
      if ($("sortWeight")) $("sortWeight").textContent = state.sortBy === "weight" ? (state.sortDir === "desc" ? "↓" : "↑") : "↕";
      if ($("sortStatus")) $("sortStatus").textContent = state.sortBy === "status" ? (state.sortDir === "desc" ? "↓" : "↑") : "↕";
      if ($("sortTime")) $("sortTime").textContent = state.sortBy === "time" ? (state.sortDir === "desc" ? "↓" : "↑") : "↕";
      renderRows();
    });
  });

  $("logBody")?.addEventListener("click", e => {
    const row = e.target.closest("tr.log-row");
    if (!row) return;
    const item = state.logs.find(x => x._id === row.dataset.id);
    if (item) openDetailModal(item);
  });

  $("exportCsvBtn")?.addEventListener("click", exportCsv);
  $("logWeightTableBtn")?.addEventListener("click", logWeightOnly);
  $("logWeightQuickBtn")?.addEventListener("click", logWeightOnly);
  $("motorStopBtn")?.addEventListener("click", () => setConveyorMotor(false, 0));
  $("motorStartBtn")?.addEventListener("click", () => setConveyorMotor(true, 255));
  $("closeModalBtn")?.addEventListener("click", closeDetailModal);
  $("detailModal")?.addEventListener("click", e => {
    if (e.target === $("detailModal")) closeDetailModal();
  });

  /* ---------- Logika Manajemen Pengguna (Sesi Admin) ---------- */
  let selectedNewRole = "operator";

  function openUserModal() {
    if (!window.StockFlowAuth || !window.StockFlowAuth.isAdmin()) {
      showToast("Akses ditolak: Hanya Administrator yang berwenang.");
      return;
    }
    const m = $("userModal");
    if (!m) return;
    hideUserModalAlert();
    renderUserManagementList();
    m.hidden = false;
    m.setAttribute("aria-hidden", "false");
    $("newFullName")?.focus();
  }

  function closeUserModal() {
    const m = $("userModal");
    if (!m) return;
    m.hidden = true;
    m.setAttribute("aria-hidden", "true");
    $("addUserForm")?.reset();
    setRoleSelection("operator");
    hideUserModalAlert();
  }

  function showUserModalAlert(msg, isError = true) {
    const box = $("userModalAlert");
    const txt = $("userModalAlertText");
    if (!box || !txt) return;
    txt.textContent = msg;
    box.style.color = isError ? "var(--accent-alert)" : "var(--accent-status)";
    box.style.borderLeftColor = isError ? "var(--accent-alert)" : "var(--accent-status)";
    box.hidden = false;
  }

  function hideUserModalAlert() {
    const box = $("userModalAlert");
    if (box) box.hidden = true;
  }

  function setRoleSelection(role) {
    selectedNewRole = role;
    const isOp = role === "operator";
    $("btnRoleOperator")?.classList.toggle("active", isOp);
    $("btnRoleAdmin")?.classList.toggle("active", !isOp);
  }

  function renderUserManagementList() {
    const container = $("userListContainer");
    const countLabel = $("userCountLabel");
    if (!container || !window.StockFlowAuth) return;

    const users = window.StockFlowAuth.getUsers();
    if (countLabel) {
      countLabel.textContent = `${users.length} akun aktif`;
    }

    container.innerHTML = users.map(u => {
      const isDefault = u.isDefault;
      const isAdminRole = u.role === "admin";
      return `
        <div class="user-item-row">
          <div class="user-item-meta">
            <div class="user-item-name">
              <span>${safe(u.name)}</span>
              <span class="role-badge-tag ${isAdminRole ? 'admin' : 'operator'}">${safe(u.roleLabel)}</span>
            </div>
            <div class="user-item-sub">
              Username: <strong style="color:var(--ink-heading); font-family:monospace;">${safe(u.username)}</strong>
              ${isDefault ? '· <em>(Akun Utama Bawaan)</em>' : '· <em>(Akun Kustom)</em>'}
            </div>
          </div>
          <div class="user-item-actions">
            ${isDefault ? `
              <span style="font-size: 11px; color: var(--ink-muted); padding: 4px 8px;">Terkunci</span>
            ` : `
              <button type="button" class="btn-delete-user" data-username="${safe(u.username)}" title="Hapus akun pengguna ini">
                Hapus
              </button>
            `}
          </div>
        </div>
      `;
    }).join("");

    container.querySelectorAll(".btn-delete-user").forEach(btn => {
      btn.addEventListener("click", () => {
        const targetUser = btn.dataset.username;
        if (!confirm(`Apakah Anda yakin ingin menghapus akun "${targetUser}"?`)) return;
        const res = window.StockFlowAuth.deleteUser(targetUser);
        if (res.success) {
          showUserModalAlert(res.message, false);
          showToast(res.message);
          renderUserManagementList();
        } else {
          showUserModalAlert(res.message, true);
        }
      });
    });
  }

  $("openUserModalBtn")?.addEventListener("click", openUserModal);
  $("closeUserModalBtn")?.addEventListener("click", closeUserModal);
  $("userModal")?.addEventListener("click", e => {
    if (e.target === $("userModal")) closeUserModal();
  });

  $("btnRoleOperator")?.addEventListener("click", () => setRoleSelection("operator"));
  $("btnRoleAdmin")?.addEventListener("click", () => setRoleSelection("admin"));

  $("addUserForm")?.addEventListener("submit", e => {
    e.preventDefault();
    hideUserModalAlert();

    const name = $("newFullName").value;
    const username = $("newUsername").value;
    const password = $("newPassword").value;
    const role = selectedNewRole;

    const res = window.StockFlowAuth.addUser({ name, username, password, role });
    if (!res.success) {
      showUserModalAlert(res.message, true);
      return;
    }

    showUserModalAlert(res.message, false);
    showToast(res.message);
    $("addUserForm").reset();
    setRoleSelection("operator");
    renderUserManagementList();
  });

  $("toggleRfidFaultBtn")?.addEventListener("click", e => {
    state.demoFaults.rfidErr = !state.demoFaults.rfidErr;
    e.currentTarget.classList.toggle("active", state.demoFaults.rfidErr);
    renderDevice();
  });
  $("toggleScaleFaultBtn")?.addEventListener("click", e => {
    state.demoFaults.scaleErr = !state.demoFaults.scaleErr;
    e.currentTarget.classList.toggle("active", state.demoFaults.scaleErr);
    renderDevice();
  });
  $("toggleWeakWifiBtn")?.addEventListener("click", e => {
    state.demoFaults.weakWifi = !state.demoFaults.weakWifi;
    e.currentTarget.classList.toggle("active", state.demoFaults.weakWifi);
    renderDevice();
  });

  /* ---------- Modul Pengaturan & Kalibrasi Timbangan (KNN Enrollment) ---------- */
  function renderKnnTable() {
    const tbody = $("knnDatasetTableBody");
    const countEl = $("knnSampleCount");
    if (countEl) countEl.textContent = state.knnSamples.length;
    if (!tbody) return;

    if (!state.knnSamples.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:14px; color:var(--ink-muted);">Belum ada sampel terdaftar.</td></tr>';
      return;
    }

    tbody.innerHTML = state.knnSamples.map((item, idx) => {
      const jalurBadge = item.jalur === 0
        ? '<span style="color:var(--accent-status); font-weight:600;">Jalur 1 (Ringan)</span>'
        : item.jalur === 1
        ? '<span style="color:var(--accent-primary); font-weight:600;">Jalur 2 (Sedang)</span>'
        : '<span style="color:var(--accent-alert); font-weight:600;">Reject (Anomali)</span>';

      return `<tr>
        <td style="padding:6px 8px; font-weight:700;">${safe(item.uid)}</td>
        <td style="padding:6px 8px;">${safe(item.prod)}</td>
        <td style="padding:6px 8px;" class="tabular">${Number(item.weight).toFixed(1)} g</td>
        <td style="padding:6px 8px;">${jalurBadge}</td>
        <td style="padding:6px 8px; text-align:right;">
          <button type="button" class="btn-util del-knn-btn" data-idx="${idx}" style="padding:2px 8px; font-size:10px;">Hapus</button>
        </td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll(".del-knn-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        const i = parseInt(e.currentTarget.dataset.idx, 10);
        if (!isNaN(i) && i >= 0 && i < state.knnSamples.length) {
          const removed = state.knnSamples.splice(i, 1);
          saveKnnSamples(state.knnSamples);
          showToast(`Sampel ${removed[0]?.uid} dihapus dari model`);
        }
      });
    });
  }

  function saveKnnSamples(arr) {
    state.knnSamples = arr;
    try {
      localStorage.setItem("stockflow_knn_samples", JSON.stringify(arr));
    } catch (_) {}
    renderKnnTable();
  }

  function openScaleModal() {
    if ($("scaleModal")) {
      $("scaleModal").hidden = false;
      renderKnnTable();
    }
  }

  function closeScaleModal() {
    if ($("scaleModal")) $("scaleModal").hidden = true;
  }

  async function toggleScaleMode() {
    const nextMode = !state.scaleMode;
    state.scaleMode = nextMode;
    if (nextMode) {
      state.motorRunning = false;
    }
    renderDevice();

    if (state.mode === "demo") {
      showToast(nextMode ? "Mode Timbangan Aktif: Dinamo motor dinonaktifkan" : "Mode Konveyor Normal Aktif");
      return;
    }

    try {
      await patchFirebase("device/status/control", {
        scaleMode: nextMode,
        motor: false,
        command: nextMode ? "scale_mode" : "conveyor_mode",
        updatedAt: { ".sv": "timestamp" }
      });
      await patchFirebase("device/status", {
        scaleMode: nextMode,
        motorRunning: false
      });
      showToast(nextMode ? "Mode Timbangan Aktif: Dinamo motor dinonaktifkan" : "Mode Konveyor Normal Aktif");
      setTimeout(load, 500);
    } catch (e) {
      showToast("Gagal mengubah mode: " + e.message);
    }
  }

  async function tareScale() {
    if (state.mode === "demo") {
      if ($("simWeightSlider")) $("simWeightSlider").value = "0";
      showToast("Timbangan di-reset ke 0.0g (Simulasi)");
      if ($("scaleLiveWeight")) $("scaleLiveWeight").textContent = "0.0 g";
      return;
    }

    try {
      await patchFirebase("device/status/control", {
        tare: true,
        updatedAt: { ".sv": "timestamp" }
      });
      showToast("Perintah Tare (Nol-kan) terkirim ke ESP8266");
      setTimeout(load, 700);
    } catch (e) {
      showToast("Gagal mengirim perintah tare: " + e.message);
    }
  }

  async function saveCurrentKnnSample() {
    const uid = ($("scaleScannedUid")?.textContent || "").trim();
    if (!uid || uid === "Menunggu Scan..." || uid === "-") {
      showToast("Tempelkan kartu RFID atau masukkan UID manual terlebih dahulu!");
      return;
    }

    let w = Number(state.device?.weightGram);
    if (!Number.isFinite(w) || w <= 0) {
      if (state.mode === "demo") {
        w = Number($("simWeightSlider")?.value) || 75.0;
      } else {
        const input = prompt(`Bobot sensor saat ini 0.0g. Masukkan nilai bobot (gram) untuk tag ${uid}:`, "75.0");
        if (input === null) return;
        w = parseFloat(input);
        if (isNaN(w) || w <= 0) {
          showToast("Nilai bobot tidak valid");
          return;
        }
      }
    }

    const prod = ($("scaleProdNameInput")?.value || "").trim() || `Produk ${uid}`;
    const jalur = parseInt($("scaleJalurSelect")?.value || "0", 10);
    const label = jalur === 0 ? "Jalur 1 (Ringan)" : jalur === 1 ? "Jalur 2 (Sedang)" : "Reject (Anomali)";

    const idx = state.knnSamples.findIndex(s => s.uid.toUpperCase() === uid.toUpperCase());
    const sampleObj = {
      uid: uid.toUpperCase(),
      prod,
      weight: Number(w.toFixed(1)),
      jalur,
      label,
      timestamp: Date.now()
    };

    if (idx !== -1) {
      state.knnSamples[idx] = sampleObj;
    } else {
      state.knnSamples.push(sampleObj);
    }

    saveKnnSamples(state.knnSamples);

    if (state.mode !== "demo") {
      try {
        await patchFirebase(`knn_dataset/${uid.toUpperCase()}`, sampleObj);
      } catch (_) {}
    }

    showToast(`Paket ${uid} (${w.toFixed(1)}g) terdaftar ke ${label}!`);
    if ($("scaleUidStatus")) {
      $("scaleUidStatus").textContent = `Terdaftar: ${prod} (${w.toFixed(1)}g · ${label})`;
      $("scaleUidStatus").style.color = "var(--accent-status)";
    }
  }

  // Event Listeners Kalibrasi & Modal
  $("settingsBtn")?.addEventListener("click", openScaleModal);
  $("closeScaleModalBtn")?.addEventListener("click", closeScaleModal);
  $("scaleModal")?.addEventListener("click", e => {
    if (e.target === $("scaleModal")) closeScaleModal();
  });
  $("toggleScaleModeBtn")?.addEventListener("click", toggleScaleMode);
  $("scaleTareBtn")?.addEventListener("click", tareScale);
  $("saveKnnSampleBtn")?.addEventListener("click", saveCurrentKnnSample);

  $("setManualUidBtn")?.addEventListener("click", () => {
    const val = ($("manualUidInput")?.value || "").trim().toUpperCase();
    if (val) {
      state.scannedUid = val;
      if ($("scaleScannedUid")) $("scaleScannedUid").textContent = val;
      if ($("scaleUidStatus")) $("scaleUidStatus").textContent = "UID manual siap didaftarkan";
      showToast(`UID manual disetel: ${val}`);
    }
  });

  $("clearKnnSamplesBtn")?.addEventListener("click", () => {
    if (confirm("Reset seluruh data latih KNN ke set acuan awal?")) {
      localStorage.removeItem("stockflow_knn_samples");
      state.knnSamples = loadKnnSamples();
      renderKnnTable();
      showToast("Dataset KNN di-reset ke acuan awal");
    }
  });

  document.querySelectorAll(".nav, .m-pill").forEach(link => {
    link.addEventListener("click", () => setActiveNav(link.dataset.section));
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (!$("scaleModal")?.hidden) {
        closeScaleModal();
        return;
      }
      if (!$("detailModal")?.hidden) {
        closeDetailModal();
        return;
      }
      if (!$("userModal")?.hidden) {
        closeUserModal();
        return;
      }
    }
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (["input", "textarea", "select", "button"].includes(tag)) return;
    if (e.key.toLowerCase() === "r") {
      load();
      showToast("Memperbarui data...");
    } else if (e.code === "Space" && state.mode === "demo") {
      e.preventDefault();
      runPackageSimulation();
    }
  });

  /* ---------- Inisialisasi ---------- */
  if (window.StockFlowAuth) {
    const activeUser = window.StockFlowAuth.requireAuth("login.html");
    if (!activeUser && !window.StockFlowAuth.isGuest()) {
      return;
    }
    window.StockFlowAuth.applyUIPermissions();
    $("logoutBtn")?.addEventListener("click", () => {
      window.StockFlowAuth.logout(true);
    });
  }

  initTheme();
  updateWeightHint();
  renderKnnTable();
  if (!cfg.demoMode && (!cfg.databaseURL || cfg.databaseURL.includes("NAMA-PROJECT"))) {
    state.mode = "demo";
  }
  syncModeButtons();
  load();
  startPolling();
})();
