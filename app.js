(() => {
  const cfg = window.STOCKFLOW_CONFIG || {};
  const $ = id => document.getElementById(id);

  const createSampleLogs = () => {
    const now = Date.now();
    return [
      { UID: "E280115A", Bobot: 248.5, Timestamp: now - 45000, Status: "Valid", Produk: "Produk A", BeratStandar: 250 },
      { UID: "BEBAN-ONLY", Bobot: 172.6, Timestamp: now - 95000, Status: "Beban Saja", Produk: "Penimbangan Langsung", BeratStandar: null },
      { UID: "04A1B2C3", Bobot: 318.2, Timestamp: now - 165000, Status: "Anomali", Produk: "Produk B", BeratStandar: 280 },
      { UID: "AABB1020", Bobot: 150.4, Timestamp: now - 340000, Status: "Valid", Produk: "Produk C", BeratStandar: 150 },
      { UID: "E28011FF", Bobot: 89.4, Timestamp: now - 580000, Status: "Reject", Produk: "Produk D", BeratStandar: 120 },
      { UID: "91BC02D4", Bobot: 501.7, Timestamp: now - 890000, Status: "Valid", Produk: "Produk E", BeratStandar: 500 },
      { UID: "7F44C901", Bobot: 253.1, Timestamp: now - 1240000, Status: "Valid", Produk: "Produk A", BeratStandar: 250 }
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
    filterStatus: "all",
    sortBy: "time",
    sortDir: "desc",
    autoStream: false,
    autoTimer: null,
    pollTimer: null,
    simBusy: false,
    soundOn: true,
    selectedPreset: { prod: "Produk A", std: 250 },
    newestKey: null,
    audioCtx: null
  };

  const safe = v => String(v ?? "—").replace(/[&<>"']/g, c => ({
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

  function labelOf(st) {
    return st === "valid" ? "VALID"
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
      // Ignore browser autoplay audio restrictions
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
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
  }

  function setConnection(isOnline, label, sub) {
    $("topDot").className = "dot" + (isOnline ? " online" : "");
    $("sideDot").className = "dot" + (isOnline ? " online" : "");
    $("connectionLabel").textContent = label;
    $("sideConnection").textContent =
      label === "CONNECTED" ? "Firebase terhubung"
        : label === "DEMO MODE" ? "Mode Simulasi"
        : "Belum terhubung";
    $("sideSub").textContent = sub;
  }

  function syncModeButtons() {
    const isDemo = state.mode === "demo";
    document.body.dataset.mode = state.mode;
    $("topLiveBtn").classList.toggle("active", !isDemo);
    $("topDemoBtn").classList.toggle("active", isDemo);
    $("sideLiveBtn").classList.toggle("active", !isDemo);
    $("sideDemoBtn").classList.toggle("active", isDemo);
    $("simulator").hidden = !isDemo;
    $("heroCta").hidden = !isDemo;
    $("simFaultBar").hidden = !isDemo;
    $("simModeBadge").textContent = isDemo ? "SIMULASI AKTIF" : "NONAKTIF";
    $("simModeBadge").className = "status-badge " + (isDemo ? "online" : "unknown");
    $("topbarSubtitle").textContent = isDemo
      ? "Pantau proses penimbangan, scan RFID, dan uji coba sortir paket secara interaktif."
      : "Pantau proses penimbangan dan validasi paket secara terpusat.";
    $("heroSubtitle").textContent = isDemo
      ? "Data RFID dan berat digabungkan oleh NodeMCU, lalu dievaluasi dan dicatat secara real-time. Coba langsung conveyor virtual di bawah!"
      : "Data RFID dan berat digabungkan oleh NodeMCU, lalu dicatat sebagai satu transaksi di Firebase.";
    if (!isDemo && document.querySelector('[data-section="simulator"].active')) {
      setActiveNav("overview");
    }
    if (isDemo) $("connectBanner").hidden = true;
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
      if (!silent) showToast("Mode Simulasi aktif — silakan mainkan conveyor & sensor!");
    } else {
      load();
      startPolling();
      if (!silent) showToast("Beralih ke Live Firebase");
    }
  }

  /* ---------- Render Core ---------- */
  function animateCounter(el, target) {
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

    $("validPercent").textContent = validPct + "%";
    $("rejectPercent").textContent = rejectPct + "%";
    $("averageWeight").innerHTML = avg === null ? "—" : `${avg.toFixed(1)}<small> g</small>`;
    $("weightRangeText").textContent = minW !== null ? `Rentang ${minW.toFixed(0)}g – ${maxW.toFixed(0)}g` : "Rata-rata berat terukur";

    $("donutTotal").textContent = state.logs.length;
    $("legendValid").textContent = valid;
    $("legendReject").textContent = reject;
    $("passRateText").textContent = validPct + "%";
    $("passRateBar").style.width = validPct + "%";

    const pct = known ? (valid / known) * 100 : 0;
    $("donut").style.background = known
      ? `conic-gradient(var(--green) 0 ${pct}%, var(--red) ${pct}% 100%)`
      : `conic-gradient(var(--line) 0 100%)`;

    $("logCount").textContent = state.logs.length + " RECORD";

    syncFilterUI();
    renderRows();
    renderChart();
    renderDevice();
  }

  function syncFilterUI() {
    $("statusFilter").value = state.filterStatus;
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
    const q = $("searchInput").value.trim().toLowerCase();
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
    $("showingText").textContent = `Menampilkan ${filtered.length} dari ${state.logs.length} transaksi`;
    if (!filtered.length) {
      $("logBody").innerHTML = '<tr><td colspan="4" class="empty">Tidak ada transaksi yang cocok.</td></tr>';
      return;
    }

    $("logBody").innerHTML = filtered.map(x => {
      const st = statusOf(x);
      const label = labelOf(st);
      const w = weightOf(x);
      const isNew = state.newestKey && x._id === state.newestKey;
      return `<tr class="log-row ${isNew ? "row-new" : ""}" data-id="${safe(x._id)}">
        <td>${safe(uidOf(x))}<span class="uid-sub">${safe(productOf(x))}</span></td>
        <td><span class="weight">${Number.isFinite(w) ? w.toFixed(1) + " g" : "—"}</span></td>
        <td><span class="pill ${st === "valid" ? "valid" : st === "reject" ? "reject" : st === "beban" ? "beban" : ""}">${label}</span></td>
        <td>${safe(fmtTime(x._time ?? x.Timestamp))}</td>
      </tr>`;
    }).join("");
  }

  /* ---------- Interactive SVG Weight Chart ---------- */
  function renderChart() {
    const svg = $("weightChart");
    const tooltip = $("chartTooltip");
    tooltip.hidden = true;

    const recent = state.logs
      .filter(x => Number.isFinite(weightOf(x)))
      .slice(0, 14)
      .reverse();

    if (!recent.length) {
      svg.innerHTML = `<text x="320" y="90" text-anchor="middle" fill="var(--muted)" font-size="12">Belum ada data berat untuk ditampilkan</text>`;
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
      return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--line)" stroke-dasharray="4 4"/>
              <text x="${padL - 6}" y="${y + 4}" text-anchor="end" fill="var(--muted)" font-size="9">${val}g</text>`;
    }).join("");

    const pts = recent.map((item, i) => {
      const w = weightOf(item);
      return { x: xAt(i), y: yAt(w), w, item };
    });

    const polyPoints = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const areaPoints = `${pts[0].x.toFixed(1)},${H - padB} ${polyPoints} ${pts[pts.length - 1].x.toFixed(1)},${H - padB}`;

    const dots = pts.map((p, idx) => {
      const st = statusOf(p.item);
      const color = st === "valid" ? "var(--green)" : st === "reject" ? "var(--red)" : "var(--blue)";
      return `<g class="chart-pt" data-idx="${idx}" style="cursor:pointer">
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="10" fill="transparent"/>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="${color}" stroke="var(--surface)" stroke-width="2"/>
      </g>`;
    }).join("");

    svg.innerHTML = `
      <defs>
        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#4778ed" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#4778ed" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <polygon points="${areaPoints}" fill="url(#chartGrad)"/>
      <polyline points="${polyPoints}" fill="none" stroke="#4778ed" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
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

    // Waktu terakhir terlihat: utamakan waktu server Firebase (lastSeenMs)
    const seen = dev ? (timeValue(dev.lastSeenMs) ?? timeValue(dev.lastSeen ?? dev.timestamp ?? dev.Timestamp)) : null;
    const age = seen ? Date.now() - seen : Infinity;
    const online = age < (state.mode === "demo" ? 60000 : 20000);

    $("deviceBadge").className = "status-badge " + (online ? "online" : dev ? "offline" : "unknown");
    $("deviceBadge").textContent = state.mode === "demo"
      ? (online ? "SIMULASI PERANGKAT ONLINE" : "SIMULASI OFFLINE")
      : (online ? "PERANGKAT ONLINE" : dev ? "PERANGKAT OFFLINE" : "BELUM TERHUBUNG");

    $("espState").textContent = online ? "Terhubung" : dev ? "Tidak aktif" : "Belum ada heartbeat";
    $("espState").style.color = online ? "var(--green)" : dev ? "var(--red)" : "var(--ink)";
    $("lastSeen").textContent = dev && seen
      ? `Terakhir terlihat: ${fmtTime(seen)}`
      : "Menunggu data perangkat";

    // Jika perangkat offline, status sensor lama tidak boleh tampil seolah-olah masih normal
    const live = online ? dev : null;

    const sensor = (key, stateId, detailId, title) => {
      const val = live?.[key];
      const good = val === true || String(val).toLowerCase() === "ok" || String(val).toLowerCase() === "true";
      $(stateId).textContent = val === undefined ? "Tidak diketahui" : good ? "Online" : "Tidak terdeteksi";
      $(detailId).textContent = val === undefined ? "Status belum dikirim" : good ? title + " terdeteksi" : "Periksa kabel / suplai";
      $(stateId).style.color = val === undefined ? "var(--ink)" : good ? "var(--green)" : "var(--red)";
    };

    sensor("rfidOk", "rfidState", "rfidDetail", "RFID RC522");
    sensor("hx711Ok", "scaleState", "scaleDetail", "Load Cell / HX711");

    // Berat live
    const wg = Number(live?.weightGram);
    $("liveWeight").textContent = Number.isFinite(wg) ? `${wg.toFixed(1)} g` : "—";
    $("liveWeightDetail").textContent = live
      ? `Raw ${live.weightRaw ?? "—"} · UID terakhir ${live.lastUID && live.lastUID !== "-" ? live.lastUID : "belum ada"}`
      : "Menunggu data timbangan";

    // Servo
    const sv = live?.servoOk;
    const svState = String(live?.servoState || "").toLowerCase();
    $("servoState").textContent = sv === undefined ? "Tidak diketahui"
      : sv === false ? "Tidak terdeteksi"
      : svState === "standby" ? "Standby"
      : svState ? svState.charAt(0).toUpperCase() + svState.slice(1) : "Online";
    $("servoState").style.color = sv === undefined ? "var(--ink)" : sv ? "var(--green)" : "var(--red)";
    $("servoDetail").textContent = live && live.servoAngle !== undefined ? `Sudut ${live.servoAngle}°` : "Status belum dikirim";

    // Wi-Fi (firmware mengirim wifiRssi, simulasi memakai rssi)
    const rssi = live ? (live.rssi ?? live.wifiRssi) : undefined;
    $("wifiState").textContent = rssi === undefined ? "Tidak diketahui" : `${rssi} dBm`;
    $("wifiDetail").textContent = rssi === undefined
      ? "RSSI belum dikirim"
      : rssi > -67 ? "Sinyal baik"
      : rssi > -80 ? "Sinyal lemah"
      : "Sinyal sangat lemah";

    const bars = $("wifiBars");
    bars.className = "wifi-bars";
    if (typeof rssi === "number") {
      if (rssi > -60) bars.classList.add("lvl-4");
      else if (rssi > -70) bars.classList.add("lvl-3");
      else if (rssi > -82) bars.classList.add("lvl-2");
      else bars.classList.add("lvl-1");
    }

    // Motor Konveyor
    const motorRun = live?.motorRunning ?? (state.mode === "demo" ? state.motorRunning : false);
    const motorSpd = live?.motorSpeed ?? (state.mode === "demo" ? state.motorSpeed : 0);
    const mBadge = $("motorBadge");
    const mIcon = $("motorStatusIcon");
    const mText = $("motorStatusText");
    const mState = $("espMotorState");
    const mDetail = $("espMotorDetail");

    if (mBadge) {
      mBadge.textContent = !online && state.mode !== "demo" ? "PERANGKAT OFFLINE" : (motorRun ? "MOTOR BERJALAN" : "MOTOR BERHENTI");
      mBadge.className = "status-badge " + (online || state.mode === "demo" ? (motorRun ? "online" : "offline") : "unknown");
    }
    if (mIcon) {
      mIcon.className = "control-icon " + (motorRun ? "running" : "stopped");
    }
    if (mText) {
      mText.textContent = motorRun
        ? `Dinamo konveyor sedang berjalan aktif (Kecepatan PWM ${motorSpd || 255}).`
        : `Dinamo konveyor dalam posisi berhenti (STOP).`;
    }
    if (mState) {
      mState.textContent = live === null ? "Tidak diketahui" : (motorRun ? "Berjalan (ON)" : "Berhenti (OFF)");
      mState.style.color = live === null ? "var(--ink)" : (motorRun ? "var(--green)" : "var(--red)");
    }
    if (mDetail) {
      mDetail.textContent = live === null ? "Status belum dikirim" : `Kecepatan PWM: ${motorSpd}`;
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
    const icon = $("motorStatusIcon");
    const text = $("motorStatusText");
    const mState = $("espMotorState");
    const mDetail = $("espMotorDetail");

    if (badge) {
      badge.textContent = isRunning ? "MOTOR BERJALAN" : "MOTOR BERHENTI";
      badge.className = "status-badge " + (isRunning ? "online" : "offline");
    }
    if (icon) {
      icon.className = "control-icon " + (isRunning ? "running" : "stopped");
    }
    if (text) {
      text.textContent = isRunning
        ? `Dinamo konveyor sedang berjalan aktif (Kecepatan PWM ${speed}).`
        : "Dinamo konveyor dalam posisi berhenti (STOP).";
    }
    if (mState) {
      mState.textContent = isRunning ? "Berjalan (ON)" : "Berhenti (OFF)";
      mState.style.color = isRunning ? "var(--green)" : "var(--red)";
    }
    if (mDetail) {
      mDetail.textContent = isRunning ? `Kecepatan PWM: ${speed}` : "Standby";
    }
  }

  async function setConveyorMotor(shouldRun, speed = 255) {
    updateMotorUI(shouldRun, speed);

    if (state.mode === "demo") {
      const belt = document.querySelector(".belt-track");
      if (belt) belt.classList.toggle("running", shouldRun);
      showToast(shouldRun ? "▶ Dinamo konveyor dijalankan (Mode Simulasi)" : "🛑 Dinamo konveyor dihentikan (Mode Simulasi)");
      return;
    }

    try {
      await patchFirebase("device/control", {
        motor: shouldRun,
        speed: speed,
        command: shouldRun ? "run" : "stop",
        updatedAt: { ".sv": "timestamp" }
      });
      showToast(shouldRun ? "▶ Perintah RUN terkirim ke ESP8266" : "🛑 Perintah STOP terkirim ke ESP8266");
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
        const input = prompt("Timbangan membaca 0.0g atau menunggu data. Masukkan nilai berat beban (gram) yang ingin dicatat:", "150.0");
        if (input === null) return;
        weight = parseFloat(input);
        if (isNaN(weight) || weight <= 0) {
          showToast("Nilai berat tidak valid");
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
      showToast(`Log beban berhasil dicatat: ${weight.toFixed(1)} g`);
      return;
    }

    try {
      await postFirebase("logs", {
        ...item,
        weightRaw: state.device?.weightRaw ?? 0,
        servoAngle: 90,
        tsServer: { ".sv": "timestamp" }
      });
      showToast(`Log beban berhasil disimpan ke Firebase: ${weight.toFixed(1)} g`);
      await load();
    } catch (e) {
      showToast("Gagal menyimpan log beban: " + e.message);
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
      $("connectBanner").hidden = state.logs.length > 0;
      if (!state.logs.length) {
        $("bannerTitle").textContent = "Firebase terhubung, tetapi log transaksi masih kosong";
        $("bannerDesc").textContent = "Sambil menunggu data dari ESP8266, Anda dapat mencoba simulasi interaktif terlebih dahulu.";
      }
      render();
    } catch (e) {
      setConnection(false, "DISCONNECTED", e.message);
      $("connectBanner").hidden = false;
      $("bannerTitle").textContent = `Gagal terhubung ke Firebase (${e.message})`;
      $("bannerDesc").textContent = "Klik tombol di kanan untuk langsung memainkan Mode Simulasi interaktif.";
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
    for (let i = 0; i < 14; i++) {
      const dot = document.createElement("span");
      dot.className = "burst-dot";
      const angle = (Math.PI * 2 * i) / 14;
      const dist = 26 + Math.random() * 38;
      dot.style.left = "82%";
      dot.style.top = "68%";
      dot.style.background = color;
      dot.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
      dot.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
      layer.appendChild(dot);
      setTimeout(() => dot.remove(), 760);
    }
  }

  function updateWeightHint() {
    const w = Number($("simWeightSlider").value);
    const std = state.selectedPreset.std;
    const diff = w - std;
    const sign = diff >= 0 ? "+" : "";
    const ok = Math.abs(diff) <= 15;
    $("simWeightLabel").textContent = `${w.toFixed(1)} g`;
    $("simDiffHint").textContent = `(Standar ${std}g · Selisih ${sign}${diff.toFixed(1)}g · ${ok ? "Dalam toleransi" : "Di luar toleransi"})`;
    $("simDiffHint").style.color = ok ? "var(--green)" : "var(--red)";
    $("pkgVisualUid").textContent = $("simUidInput").value.trim().toUpperCase() || "E280115A";
    $("pkgVisualProd").textContent = state.selectedPreset.prod;
  }

  function runPackageSimulation(customPacket = null) {
    if (state.simBusy) return;
    if (state.mode !== "demo") {
      switchMode("demo", true);
      showToast("Beralih ke Mode Simulasi agar data Live tetap aman");
    }

    state.simBusy = true;
    const uid = (customPacket?.UID || $("simUidInput").value.trim() || randomUid()).toUpperCase();
    const prod = customPacket?.Produk || state.selectedPreset.prod;
    const std = customPacket?.BeratStandar || state.selectedPreset.std;
    const weight = customPacket?.Bobot ?? Number($("simWeightSlider").value);

    const pkg = $("simPackage");
    const belt = document.querySelector(".belt-track");
    const stRfid = $("stationRfid");
    const stScale = $("stationScale");
    const stGate = $("stationGate");
    const lcd = $("lcdScreen");
    const gateArm = $("gateArm");
    const gateResult = $("gateResult");

    $("pkgVisualUid").textContent = uid;
    $("pkgVisualProd").textContent = prod;

    pkg.className = "sim-package";
    gateArm.className = "gate-arm";
    stRfid.classList.remove("lit");
    stScale.classList.remove("lit");
    stGate.classList.remove("lit-ok", "lit-err");
    belt.classList.add("running");

    // Step 1: RFID Scan
    setTimeout(() => {
      pkg.classList.add("at-rfid");
      stRfid.classList.add("lit");
      $("rfidLed").classList.add("scanning");
      $("rfidReadout").textContent = state.demoFaults.rfidErr ? "READ ERROR!" : uid;
      sfxScan();
    }, 80);

    // Step 2: Load Cell Scale with realistic LCD settling
    let jitterTimer = null;
    setTimeout(() => {
      stRfid.classList.remove("lit");
      $("rfidLed").classList.remove("scanning");
      pkg.classList.add("at-scale");
      stScale.classList.add("lit");

      let ticks = 0;
      jitterTimer = setInterval(() => {
        ticks++;
        if (state.demoFaults.scaleErr) {
          lcd.textContent = "ERR HX711";
        } else {
          const wobble = (Math.random() - 0.5) * 9;
          lcd.textContent = `${Math.max(0, weight + wobble).toFixed(1)} g`;
        }
        if (ticks >= 7) {
          clearInterval(jitterTimer);
          lcd.textContent = state.demoFaults.scaleErr ? "0.0 g" : `${weight.toFixed(1)} g`;
        }
      }, 65);
    }, 560);

    // Step 3: Gate Decision + Record Log
    setTimeout(() => {
      clearInterval(jitterTimer);
      stScale.classList.remove("lit");

      const finalWeight = state.demoFaults.scaleErr ? 0 : weight;
      const isValid = !state.demoFaults.rfidErr && !state.demoFaults.scaleErr && Math.abs(finalWeight - std) <= 15;
      const statusStr = isValid ? "Valid" : "Anomali";

      pkg.classList.add(isValid ? "at-gate-valid" : "at-gate-reject");
      gateArm.classList.add(isValid ? "valid" : "reject");
      stGate.classList.add(isValid ? "lit-ok" : "lit-err");
      gateResult.textContent = isValid ? "JALUR VALID ✓" : "JALUR REJECT !";
      gateResult.style.color = isValid ? "var(--green)" : "var(--red)";

      if (isValid) {
        sfxValid();
        spawnBurst("#1eaa78");
      } else {
        sfxReject();
        spawnBurst("#e35d67");
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

    // Reset stage back to ready
    setTimeout(() => {
      belt.classList.remove("running");
      pkg.className = "sim-package";
      $("rfidReadout").textContent = "SIAP PINDAI";
      state.simBusy = false;
    }, 1900);
  }

  function spawnRandomSimulation() {
    const catalog = [
      { prod: "Produk A", std: 250 },
      { prod: "Produk B", std: 280 },
      { prod: "Produk C", std: 150 },
      { prod: "Produk E", std: 500 }
    ];
    const pick = catalog[Math.floor(Math.random() * catalog.length)];
    const makeAnomaly = Math.random() < 0.28;
    const offset = makeAnomaly
      ? (Math.random() < 0.5 ? -1 : 1) * (24 + Math.random() * 45)
      : (Math.random() - 0.5) * 14;
    const bobot = Math.max(25, Number((pick.std + offset).toFixed(1)));
    const uid = randomUid();

    $("simUidInput").value = uid;
    state.selectedPreset = pick;
    $("simWeightSlider").value = bobot;
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
    btn.classList.toggle("running-auto", next);
    heroBtn.classList.toggle("active", next);
    btn.textContent = next ? "⏸ Pause Stream" : "▶ Auto Stream";
    heroBtn.textContent = next ? "⏸ Hentikan Auto" : "▶ Auto Conveyor";

    if (next) {
      if (state.mode !== "demo") switchMode("demo", true);
      spawnRandomSimulation();
      state.autoTimer = setInterval(() => {
        if (!state.simBusy) spawnRandomSimulation();
      }, 2500);
      showToast("Auto Conveyor aktif — paket diproses otomatis!");
    }
  }

  /* ---------- Modal Inspector & CSV ---------- */
  function openDetailModal(item) {
    const w = weightOf(item);
    const std = Number(item.BeratStandar ?? item.beratStandar ?? NaN);
    const st = statusOf(item);
    const diff = Number.isFinite(w) && Number.isFinite(std) ? w - std : null;
    const label = labelOf(st);

    $("modalTitle").textContent = `Paket ${uidOf(item)}`;
    $("modalBody").innerHTML = `
      <div class="modal-grid">
        <div class="m-stat"><small>UID RFID</small><b>${safe(uidOf(item))}</b></div>
        <div class="m-stat"><small>PRODUK</small><b>${safe(productOf(item))}</b></div>
        <div class="m-stat"><small>BERAT AKTUAL</small><b>${Number.isFinite(w) ? w.toFixed(1) + " g" : "—"}</b></div>
        <div class="m-stat"><small>KLASIFIKASI</small><span class="pill ${st === "valid" ? "valid" : st === "reject" ? "reject" : ""}">${label}</span></div>
        <div class="m-stat"><small>BERAT STANDAR</small><b>${Number.isFinite(std) ? std.toFixed(1) + " g" : "Tidak dicatat"}</b></div>
        <div class="m-stat"><small>SELISIH</small><b style="color:${diff === null ? "var(--ink)" : Math.abs(diff) <= 15 ? "var(--green)" : "var(--red)"}">${diff === null ? "—" : (diff >= 0 ? "+" : "") + diff.toFixed(1) + " g"}</b></div>
      </div>
      <div class="m-stat"><small>WAKTU TRANSAKSI</small><b>${safe(fmtTime(item._time ?? item.Timestamp))}</b></div>
      <pre class="modal-json">${safe(JSON.stringify({
        UID: uidOf(item),
        Produk: productOf(item),
        Bobot: Number.isFinite(w) ? w : null,
        BeratStandar: Number.isFinite(std) ? std : undefined,
        Status: item.Status ?? item.status ?? label,
        Timestamp: item.Timestamp ?? item.timestamp ?? item.waktu ?? item.createdAt
      }, null, 2))}</pre>
      <div class="modal-actions">
        <button type="button" class="btn btn-quiet btn-sm" id="copyUidBtn">Salin UID</button>
        <button type="button" class="btn btn-primary btn-sm" id="modalDoneBtn">Tutup</button>
      </div>
    `;

    $("detailModal").hidden = false;
    $("detailModal").setAttribute("aria-hidden", "false");

    $("copyUidBtn").onclick = async () => {
      try {
        await navigator.clipboard.writeText(String(uidOf(item)));
        showToast("UID disalin ke clipboard");
      } catch {
        showToast("Gagal menyalin UID");
      }
    };
    $("modalDoneBtn").onclick = closeDetailModal;
  }

  function closeDetailModal() {
    $("detailModal").hidden = true;
    $("detailModal").setAttribute("aria-hidden", "true");
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
    $("themeBtn").textContent = theme === "dark" ? "☀" : "🌙";
    $("themeBtn").setAttribute("aria-pressed", String(theme === "dark"));
    localStorage.setItem("stockflow-theme", theme);
  }

  function setActiveNav(sectionId) {
    document.querySelectorAll(".nav, .m-pill").forEach(el => {
      el.classList.toggle("active", el.dataset.section === sectionId);
    });
  }

  /* ---------- Event Listeners ---------- */
  $("topLiveBtn").addEventListener("click", () => switchMode("live"));
  $("sideLiveBtn").addEventListener("click", () => switchMode("live"));
  $("topDemoBtn").addEventListener("click", () => switchMode("demo"));
  $("sideDemoBtn").addEventListener("click", () => switchMode("demo"));
  $("bannerSimBtn").addEventListener("click", () => switchMode("demo"));

  $("refreshBtn").addEventListener("click", () => {
    load();
    showToast("Memperbarui data...");
  });

  $("soundBtn").addEventListener("click", () => {
    state.soundOn = !state.soundOn;
    $("soundBtn").textContent = state.soundOn ? "🔊" : "🔇";
    $("soundBtn").setAttribute("aria-pressed", String(state.soundOn));
    if (state.soundOn) sfxScan();
    showToast(state.soundOn ? "Efek suara aktif" : "Efek suara dimatikan");
  });

  $("themeBtn").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    applyTheme(current === "dark" ? "light" : "dark");
  });

  $("heroArt").addEventListener("click", () => {
    const art = $("heroArt");
    art.classList.remove("ping");
    void art.offsetWidth;
    art.classList.add("ping");
    sfxScan();
    showToast("RFID + Load Cell siap memindai!");
  });

  $("heroQuickScanBtn").addEventListener("click", () => {
    $("simulator").scrollIntoView({ behavior: "smooth", block: "center" });
    spawnRandomSimulation();
  });

  $("heroAutoBtn").addEventListener("click", () => toggleAutoStream());
  $("autoSimBtn").addEventListener("click", () => toggleAutoStream());
  $("runSimBtn").addEventListener("click", () => runPackageSimulation());

  $("randomUidBtn").addEventListener("click", () => {
    $("simUidInput").value = randomUid();
    updateWeightHint();
    sfxScan();
  });

  $("simUidInput").addEventListener("input", updateWeightHint);
  $("simWeightSlider").addEventListener("input", updateWeightHint);

  document.querySelectorAll(".chip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".chip-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.selectedPreset = {
        prod: btn.dataset.prod,
        std: Number(btn.dataset.std)
      };
      $("simWeightSlider").value = btn.dataset.weight;
      $("simUidInput").value = randomUid();
      updateWeightHint();
    });
  });

  $("resetDemoBtn").addEventListener("click", () => {
    toggleAutoStream(false);
    state.demoFaults = { rfidErr: false, scaleErr: false, weakWifi: false };
    document.querySelectorAll(".btn-mini-pill").forEach(b => b.classList.remove("active"));
    state.demoLogs = createSampleLogs();
    state.newestKey = null;
    if (state.mode !== "demo") switchMode("demo", true);
    else load();
    showToast("Data simulasi dikembalikan ke awal");
  });

  $("searchInput").addEventListener("input", renderRows);
  $("statusFilter").addEventListener("change", e => setStatusFilter(e.target.value));
  document.querySelectorAll(".f-pill").forEach(btn => {
    btn.addEventListener("click", () => setStatusFilter(btn.dataset.val));
  });
  document.querySelectorAll(".stat-card[data-filter], .legend-item[data-filter]").forEach(el => {
    el.addEventListener("click", () => setStatusFilter(el.dataset.filter));
  });

  $("donut").addEventListener("click", () => {
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
      $("sortWeight").textContent = state.sortBy === "weight" ? (state.sortDir === "desc" ? "↓" : "↑") : "↕";
      $("sortStatus").textContent = state.sortBy === "status" ? (state.sortDir === "desc" ? "↓" : "↑") : "↕";
      $("sortTime").textContent = state.sortBy === "time" ? (state.sortDir === "desc" ? "↓" : "↑") : "↕";
      renderRows();
    });
  });

  $("logBody").addEventListener("click", e => {
    const row = e.target.closest("tr.log-row");
    if (!row) return;
    const item = state.logs.find(x => x._id === row.dataset.id);
    if (item) openDetailModal(item);
  });

  $("exportCsvBtn").addEventListener("click", exportCsv);
  $("logWeightTableBtn")?.addEventListener("click", logWeightOnly);
  $("logWeightQuickBtn")?.addEventListener("click", logWeightOnly);
  $("motorStopBtn")?.addEventListener("click", () => setConveyorMotor(false, 0));
  $("motorStartBtn")?.addEventListener("click", () => setConveyorMotor(true, 255));
  $("closeModalBtn").addEventListener("click", closeDetailModal);
  $("detailModal").addEventListener("click", e => {
    if (e.target === $("detailModal")) closeDetailModal();
  });

  $("toggleRfidFaultBtn").addEventListener("click", e => {
    state.demoFaults.rfidErr = !state.demoFaults.rfidErr;
    e.currentTarget.classList.toggle("active", state.demoFaults.rfidErr);
    renderDevice();
  });
  $("toggleScaleFaultBtn").addEventListener("click", e => {
    state.demoFaults.scaleErr = !state.demoFaults.scaleErr;
    e.currentTarget.classList.toggle("active", state.demoFaults.scaleErr);
    renderDevice();
  });
  $("toggleWeakWifiBtn").addEventListener("click", e => {
    state.demoFaults.weakWifi = !state.demoFaults.weakWifi;
    e.currentTarget.classList.toggle("active", state.demoFaults.weakWifi);
    renderDevice();
  });

  document.querySelectorAll(".nav, .m-pill").forEach(link => {
    link.addEventListener("click", () => setActiveNav(link.dataset.section));
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("detailModal").hidden) {
      closeDetailModal();
      return;
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

  /* ---------- Init ---------- */
  initTheme();
  updateWeightHint();
  if (!cfg.demoMode && (!cfg.databaseURL || cfg.databaseURL.includes("NAMA-PROJECT"))) {
    state.mode = "demo";
  }
  syncModeButtons();
  load();
  startPolling();
})();
