(function () {
  const TOKEN_KEY = "stealth_token";
  const API = window.STEALTH_API || "";

  function apiBase() {
    // same origin when served by node; otherwise empty = relative /api
    return API || "";
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    const res = await fetch(apiBase() + path, Object.assign({}, opts, { headers }));
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok) {
      const err = new Error(data.error || res.statusText || "request failed");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function toast(msg, type) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast " + (type || "");
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 3500);
  }

  let meCache = null;

  async function fetchMe() {
    if (!getToken()) {
      meCache = null;
      return null;
    }
    try {
      meCache = await api("/api/me");
      return meCache;
    } catch {
      setToken("");
      meCache = null;
      return null;
    }
  }

  async function updateNav() {
    const loginBtn = document.getElementById("nav-login");
    const regBtn = document.getElementById("nav-register");
    const logoutBtn = document.getElementById("nav-logout");
    const dashLink = document.getElementById("nav-dash");
    const me = await fetchMe();

    if (me) {
      if (loginBtn) loginBtn.classList.add("hidden");
      if (regBtn) regBtn.classList.add("hidden");
      if (logoutBtn) {
        logoutBtn.classList.remove("hidden");
        logoutBtn.textContent = "Logout (" + (me.email || "").split("@")[0] + ")";
      }
      if (dashLink) {
        if (me.planStatus === "paid" || me.role === "admin") dashLink.classList.remove("hidden");
        else dashLink.classList.add("hidden");
      }
    } else {
      if (loginBtn) loginBtn.classList.remove("hidden");
      if (regBtn) regBtn.classList.remove("hidden");
      if (logoutBtn) logoutBtn.classList.add("hidden");
      if (dashLink) dashLink.classList.add("hidden");
    }
  }

  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "nav-logout") {
      setToken("");
      meCache = null;
      updateNav();
      toast("Logged out", "success");
      const path = window.location.pathname;
      if (path.includes("dashboard") || path.includes("admin")) {
        window.location.href = "index.html";
      }
    }
  });

  // Register
  const regForm = document.getElementById("register-form");
  if (regForm) {
    regForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = (document.getElementById("reg-email").value || "").trim().toLowerCase();
      const pass = document.getElementById("reg-pass").value || "";
      const pass2 = document.getElementById("reg-pass2").value || "";
      const err = document.getElementById("auth-error");
      err.classList.remove("show");
      if (pass !== pass2) {
        err.textContent = "Passwords do not match.";
        err.classList.add("show");
        return;
      }
      try {
        const data = await api("/api/register", {
          method: "POST",
          body: JSON.stringify({ email, password: pass })
        });
        setToken(data.token);
        toast("Account created", "success");
        setTimeout(() => (window.location.href = "index.html#plans"), 400);
      } catch (ex) {
        err.textContent = ex.message || "Register failed";
        err.classList.add("show");
      }
    });
  }

  // Login
  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = (document.getElementById("login-email").value || "").trim().toLowerCase();
      const pass = document.getElementById("login-pass").value || "";
      const err = document.getElementById("auth-error");
      err.classList.remove("show");
      try {
        const data = await api("/api/login", {
          method: "POST",
          body: JSON.stringify({ email, password: pass })
        });
        setToken(data.token);
        toast("Logged in", "success");
        setTimeout(() => {
          if (data.user.role === "admin") window.location.href = "admin.html";
          else if (data.user.planStatus === "paid") window.location.href = "dashboard.html";
          else window.location.href = "index.html#plans";
        }, 400);
      } catch (ex) {
        err.textContent = ex.message || "Login failed";
        err.classList.add("show");
      }
    });
  }

  // Plans + live NOWPayments (CTRADER-style)
  let currentOrderId = null;
  let currentPaymentId = null;
  let statusPoll = null;
  let selectedPlan = null;
  let selectedPrice = null;

  document.querySelectorAll(".btn-plan").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!getToken()) {
        toast("Login required to select a plan", "error");
        setTimeout(() => (window.location.href = "login.html"), 700);
        return;
      }
      selectedPlan = btn.dataset.plan;
      selectedPrice = btn.dataset.price;
      openPayModal(selectedPlan, selectedPrice);
    });
  });

  const modal = document.getElementById("pay-modal");

  function openPayModal(plan, price) {
    if (!modal) return;
    const nameMap = { starter: "Starter", pro: "Pro", elite: "Elite" };
    document.getElementById("modal-plan-name").textContent =
      (nameMap[plan] || plan) + " — $" + price + " lifetime";
    document.getElementById("pay-amount").textContent = "$" + price;
    document.getElementById("pay-status").classList.add("hidden");
    document.getElementById("pay-status").textContent = "";
    document.getElementById("addr-row").style.display = "none";
    document.getElementById("pay-crypto-line").textContent = "";
    const qrImg = document.getElementById("pay-qr-img");
    if (qrImg) { qrImg.style.display = "none"; qrImg.src = ""; }
    const qrPh = document.getElementById("qr-code");
    if (qrPh) { qrPh.style.display = "none"; qrPh.innerHTML = ""; }
    document.getElementById("open-invoice").classList.add("hidden");
    document.getElementById("create-live-pay").classList.remove("hidden");
    document.getElementById("create-live-pay").textContent = "Get payment address";
    currentOrderId = null;
    currentPaymentId = null;
    if (statusPoll) { clearInterval(statusPoll); statusPoll = null; }
    modal.classList.remove("hidden");
    // auto-fetch live address for selected crypto (CTRADER behavior)
    createPay(plan);
  }

  function closePayModal() {
    modal?.classList.add("hidden");
    if (statusPoll) {
      clearInterval(statusPoll);
      statusPoll = null;
    }
  }

  document.getElementById("modal-close")?.addEventListener("click", closePayModal);
  document.getElementById("cancel-pay")?.addEventListener("click", closePayModal);
  modal?.querySelector(".modal-backdrop")?.addEventListener("click", closePayModal);

  document.getElementById("copy-addr")?.addEventListener("click", () => {
    const el = document.getElementById("pay-address");
    if (!el || !el.value) return;
    navigator.clipboard.writeText(el.value).then(() => toast("Address copied", "success")).catch(() => {
      el.select();
      toast("Select and copy manually", "error");
    });
  });

  document.getElementById("create-live-pay")?.addEventListener("click", () => {
    if (!selectedPlan) return;
    createPay(selectedPlan);
  });

  document.getElementById("pay-currency")?.addEventListener("change", () => {
    if (!selectedPlan || !modal || modal.classList.contains("hidden")) return;
    createPay(selectedPlan);
  });

  document.getElementById("check-status")?.addEventListener("click", () => {
    if (currentOrderId) checkStatus();
    else toast("Create a payment first", "error");
  });

  async function createPay(plan) {
    const payCurrency = (document.getElementById("pay-currency")?.value || "usdttrc20");
    document.getElementById("pay-loading").classList.add("hidden");
    document.getElementById("pay-body").classList.remove("hidden");
    const ql = document.getElementById("qr-loading");
    if (ql) ql.classList.add("show");
    const qrImg0 = document.getElementById("pay-qr-img");
    if (qrImg0) qrImg0.style.display = "none";
    document.getElementById("addr-row").style.display = "none";
    document.getElementById("pay-crypto-line").textContent = "Fetching address…";
    try {
      const data = await api("/api/pay/create", {
        method: "POST",
        body: JSON.stringify({ plan, pay_currency: payCurrency })
      });
      if (data.alreadyPaid) {
        toast("Already paid — opening dashboard", "success");
        window.location.href = "dashboard.html";
        return;
      }
      currentOrderId = data.orderId;
      currentPaymentId = data.paymentId || null;
      document.getElementById("pay-loading").classList.add("hidden");
      document.getElementById("pay-body").classList.remove("hidden");

      if (data.demo || (!data.payAddress && !data.invoiceUrl && !data.paymentId)) {
        document.getElementById("pay-note").textContent =
          "LIVE KEY MISSING: put NOWPAYMENTS_API_KEY in .env and restart node server\standalone.js. Until then only demo confirm works.";
        document.getElementById("pay-status").textContent = "Demo mode — no real deposit address";
        document.getElementById("pay-status").classList.remove("hidden");
        document.getElementById("create-live-pay").classList.remove("hidden");
        document.getElementById("open-invoice").classList.add("hidden");
        const qrPh = document.getElementById("qr-code");
        if (qrPh) { qrPh.style.display = "grid"; }
        drawFallbackQR(plan, data.amount || "", "");
        return;
      }

      if (data.mode === "payment" && data.payAddress) {
        document.getElementById("create-live-pay").classList.add("hidden");
        document.getElementById("pay-note").textContent =
          "Send only on the correct network. Amount must match. We auto-check status.";
        document.getElementById("pay-crypto-line").textContent =
          (data.payAmount || "") + " " + String(data.payCurrency || payCurrency).toUpperCase() +
          "  ≈  $" + Number(data.amount).toFixed(2) + " USD";
        document.getElementById("addr-row").style.display = "flex";
        document.getElementById("pay-address").value = data.payAddress;
        const qrImg = document.getElementById("pay-qr-img");
        const qrPh = document.getElementById("qr-code");
        if (ql) ql.classList.remove("show");
        if (qrImg) {
          qrImg.onload = function () { qrImg.style.display = "block"; };
          qrImg.src = "https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=12&ecc=M&data=" + encodeURIComponent(data.payAddress);
          qrImg.style.display = "block";
        }
        if (qrPh) qrPh.style.display = "none";
        toast("Payment address ready", "success");
        if (statusPoll) clearInterval(statusPoll);
        statusPoll = setInterval(checkStatus, 8000);
        return;
      }

      // invoice fallback
      if (data.invoiceUrl) {
        document.getElementById("create-live-pay").classList.add("hidden");
        document.getElementById("open-invoice").classList.remove("hidden");
        document.getElementById("open-invoice").href = data.invoiceUrl;
        document.getElementById("open-invoice").textContent = "Open NOWPayments checkout";
        document.getElementById("pay-note").textContent =
          "Hosted checkout ready. Pay there, then check status or wait for redirect.";
        drawFallbackQR(plan, data.amount || "", data.invoiceUrl);
        if (statusPoll) clearInterval(statusPoll);
        statusPoll = setInterval(checkStatus, 10000);
      }
    } catch (ex) {
      document.getElementById("pay-loading").classList.add("hidden");
      document.getElementById("pay-body").classList.remove("hidden");
      const qlE = document.getElementById("qr-loading");
      if (qlE) qlE.classList.remove("show");
      const detail = (ex.data && (ex.data.detail || ex.data.error)) ? JSON.stringify(ex.data.detail || ex.data.error).slice(0, 180) : (ex.message || "failed");
      document.getElementById("pay-note").textContent = "NOWPayments error: " + detail;
      document.getElementById("pay-status").textContent = detail;
      document.getElementById("pay-status").classList.remove("hidden");
      document.getElementById("create-live-pay").classList.remove("hidden");
      toast(ex.message || "Payment create failed", "error");
    }
  }

  async function checkStatus() {
    if (!currentOrderId) return;
    try {
      const data = await api("/api/pay/status?orderId=" + encodeURIComponent(currentOrderId));
      if (data.status === "paid") {
        document.getElementById("pay-status").textContent = "Paid. Redirecting…";
        document.getElementById("pay-status").classList.remove("hidden");
        toast("Payment confirmed", "success");
        if (statusPoll) { clearInterval(statusPoll); statusPoll = null; }
        setTimeout(() => (window.location.href = "dashboard.html?paid=1"), 800);
      } else if (data.demo) {
        // allow demo confirm
        try {
          await api("/api/pay/confirm-demo", {
            method: "POST",
            body: JSON.stringify({ orderId: currentOrderId })
          });
          toast("Demo payment confirmed", "success");
          window.location.href = "dashboard.html?paid=1";
        } catch (e2) {
          document.getElementById("pay-status").textContent = e2.message;
          document.getElementById("pay-status").classList.remove("hidden");
        }
      } else {
        document.getElementById("pay-status").textContent =
          "Status: " + (data.status || "waiting") + " — keep this page open";
        document.getElementById("pay-status").classList.remove("hidden");
      }
    } catch (ex) {
      document.getElementById("pay-status").textContent = ex.message;
      document.getElementById("pay-status").classList.remove("hidden");
    }
  }

  function drawFallbackQR(plan, price, url) {
    const box = document.getElementById("qr-code");
    if (!box) return;
    box.style.display = "grid";
    box.innerHTML = "";
    const canvas = document.createElement("canvas");
    canvas.width = 164;
    canvas.height = 164;
    box.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 164, 164);
    ctx.fillStyle = "#111";
    const seed = ((plan || "") + (price || "") + (url || "")).split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    for (let y = 0; y < 21; y++) {
      for (let x = 0; x < 21; x++) {
        const v = (seed * (x + 1) * (y + 3) + x * 17 + y * 31) % 7;
        if (v < 3 || (x < 3 && y < 3) || (x > 17 && y < 3) || (x < 3 && y > 17)) {
          ctx.fillRect(8 + x * 7, 8 + y * 7, 6, 6);
        }
      }
    }
    function finder(ox, oy) {
      ctx.fillStyle = "#111";
      ctx.fillRect(ox, oy, 28, 28);
      ctx.fillStyle = "#fff";
      ctx.fillRect(ox + 4, oy + 4, 20, 20);
      ctx.fillStyle = "#111";
      ctx.fillRect(ox + 8, oy + 8, 12, 12);
    }
    finder(8, 8);
    finder(128, 8);
    finder(8, 128);
    ctx.fillStyle = "#ff1a1a";
    ctx.fillRect(70, 70, 24, 24);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("S", 82, 86);
  }

  window.StealthAuth = {
    api,
    getToken,
    setToken,
    fetchMe,
    toast
  };

  updateNav();
})();
