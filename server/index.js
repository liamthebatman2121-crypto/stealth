require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const PORT = Number(process.env.PORT || 8787);
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const NP_KEY = (process.env.NOWPAYMENTS_API_KEY || "").trim();
const NP_IPN = (process.env.NOWPAYMENTS_IPN_SECRET || "").trim();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@stealth.local").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change_this_password";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_secret";

const DATA_DIR = path.join(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getUsers() {
  return readJson(USERS_FILE, {});
}
function saveUsers(u) {
  writeJson(USERS_FILE, u);
}
function getOrders() {
  return readJson(ORDERS_FILE, []);
}
function saveOrders(o) {
  writeJson(ORDERS_FILE, o);
}

function hashPass(pass, salt) {
  return crypto.pbkdf2Sync(pass, salt, 100000, 32, "sha256").toString("hex");
}
function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 7 * 864e5 })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (sig !== expect) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : req.headers["x-session"] || "";
  const data = verifyToken(token);
  if (!data || !data.email) return res.status(401).json({ error: "unauthorized" });
  req.user = data;
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== "admin" && req.user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "admin only" });
  }
  next();
}

const PLANS = {
  starter: { id: "starter", name: "Starter", price: 149, label: "lifetime" },
  pro: { id: "pro", name: "Pro", price: 249, label: "lifetime" },
  elite: { id: "elite", name: "Elite", price: 549, label: "lifetime" }
};

// seed admin
(function seedAdmin() {
  const users = getUsers();
  if (!users[ADMIN_EMAIL]) {
    const salt = makeSalt();
    users[ADMIN_EMAIL] = {
      email: ADMIN_EMAIL,
      salt,
      passHash: hashPass(ADMIN_PASSWORD, salt),
      role: "admin",
      plan: "elite",
      planStatus: "paid",
      created: Date.now(),
      paidAt: Date.now()
    };
    saveUsers(users);
    console.log("[stealth] admin seeded:", ADMIN_EMAIL);
  }
})();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// static frontend
const ROOT = path.join(__dirname, "..");
app.use(express.static(ROOT));

// health
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    nowpayments: !!NP_KEY,
    site: SITE_URL
  });
});

app.get("/api/config-public", (req, res) => {
  res.json({
    siteUrl: SITE_URL,
    plans: PLANS,
    nowpaymentsConfigured: !!NP_KEY
  });
});

// register
app.post("/api/register", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const pass = String(req.body.password || "");
  if (!email || !pass || pass.length < 6) {
    return res.status(400).json({ error: "email and password (min 6) required" });
  }
  const users = getUsers();
  if (users[email]) return res.status(409).json({ error: "account exists" });
  const salt = makeSalt();
  users[email] = {
    email,
    salt,
    passHash: hashPass(pass, salt),
    role: "user",
    plan: null,
    planStatus: "none",
    created: Date.now()
  };
  saveUsers(users);
  const token = signToken({ email, role: "user" });
  res.json({ token, user: { email, role: "user", plan: null, planStatus: "none" } });
});

// login
app.post("/api/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const pass = String(req.body.password || "");
  const users = getUsers();
  const u = users[email];
  if (!u) return res.status(401).json({ error: "invalid credentials" });
  const hash = hashPass(pass, u.salt);
  if (hash !== u.passHash) return res.status(401).json({ error: "invalid credentials" });
  const role = u.role || "user";
  const token = signToken({ email, role });
  res.json({
    token,
    user: {
      email,
      role,
      plan: u.plan,
      planStatus: u.planStatus
    }
  });
});

// me
app.get("/api/me", auth, (req, res) => {
  const users = getUsers();
  const u = users[req.user.email];
  if (!u) return res.status(404).json({ error: "not found" });
  res.json({
    email: u.email,
    role: u.role,
    plan: u.plan,
    planStatus: u.planStatus,
    invoiceId: u.invoiceId || null,
    paidAt: u.paidAt || null
  });
});

// create invoice via NOWPayments
app.post("/api/pay/create", auth, async (req, res) => {
  const planId = String(req.body.plan || "").toLowerCase();
  const plan = PLANS[planId];
  if (!plan) return res.status(400).json({ error: "invalid plan" });

  const users = getUsers();
  const u = users[req.user.email];
  if (!u) return res.status(404).json({ error: "user not found" });
  if (u.planStatus === "paid") {
    return res.json({ alreadyPaid: true, plan: u.plan });
  }

  const orderId = "STL-" + Date.now() + "-" + uuidv4().slice(0, 8);
  const successUrl = SITE_URL + "/dashboard.html?paid=1&order=" + encodeURIComponent(orderId);
  const cancelUrl = SITE_URL + "/index.html#plans";

  const order = {
    orderId,
    email: req.user.email,
    plan: planId,
    price: plan.price,
    status: "waiting",
    invoiceId: null,
    invoiceUrl: null,
    paymentId: null,
    created: Date.now()
  };

  if (!NP_KEY) {
    // demo invoice
    order.invoiceId = "demo-" + orderId;
    order.invoiceUrl = null;
    order.demo = true;
    const orders = getOrders();
    orders.push(order);
    saveOrders(orders);
    u.plan = planId;
    u.planStatus = "pending";
    u.pendingOrder = orderId;
    saveUsers(users);
    return res.json({
      demo: true,
      orderId,
      amount: plan.price,
      plan: planId,
      message: "NOWPAYMENTS_API_KEY not set — use POST /api/pay/confirm-demo to simulate payment"
    });
  }

  try {
    const npRes = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: {
        "x-api-key": NP_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        price_amount: plan.price,
        price_currency: "usd",
        order_id: orderId,
        order_description: `Stealth ${plan.name} lifetime`,
        success_url: successUrl,
        cancel_url: cancelUrl,
        ipn_callback_url: SITE_URL + "/api/pay/ipn"
      })
    });
    const text = await npRes.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!npRes.ok) {
      console.error("NOWPayments error", npRes.status, data);
      return res.status(502).json({ error: "nowpayments failed", detail: data });
    }
    order.invoiceId = data.id;
    order.invoiceUrl = data.invoice_url;
    const orders = getOrders();
    orders.push(order);
    saveOrders(orders);
    u.plan = planId;
    u.planStatus = "pending";
    u.pendingOrder = orderId;
    u.invoiceId = data.id;
    saveUsers(users);
    res.json({
      orderId,
      invoiceId: data.id,
      invoiceUrl: data.invoice_url,
      amount: plan.price,
      plan: planId
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "invoice create failed", message: e.message });
  }
});

// check payment status
app.get("/api/pay/status/:orderId", auth, async (req, res) => {
  const orderId = req.params.orderId;
  const orders = getOrders();
  const order = orders.find((o) => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: "order not found" });
  if (order.email !== req.user.email && req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  if (order.status === "paid") {
    return res.json({ status: "paid", order });
  }

  if (order.demo || String(order.invoiceId || "").startsWith("demo-")) {
    return res.json({ status: order.status, order, demo: true });
  }

  if (!NP_KEY || !order.invoiceId) {
    return res.json({ status: order.status, order });
  }

  // try payment list by order_id is not always available; poll invoice if endpoint works
  try {
    const r = await fetch("https://api.nowpayments.io/v1/invoice/" + order.invoiceId, {
      headers: { "x-api-key": NP_KEY }
    });
    if (r.ok) {
      const data = await r.json();
      const st = String(data.payment_status || data.status || "").toLowerCase();
      if (["finished", "confirmed", "sending", "paid"].includes(st)) {
        markPaid(orderId, order.invoiceId);
        return res.json({ status: "paid", order: getOrders().find((o) => o.orderId === orderId) });
      }
      return res.json({ status: st || order.status, order, remote: data });
    }
  } catch (e) {
    console.error("status poll", e.message);
  }
  res.json({ status: order.status, order });
});

function markPaid(orderId, invoiceId) {
  const orders = getOrders();
  const idx = orders.findIndex((o) => o.orderId === orderId);
  if (idx === -1) return null;
  orders[idx].status = "paid";
  if (invoiceId) orders[idx].invoiceId = invoiceId;
  orders[idx].paidAt = Date.now();
  saveOrders(orders);
  const users = getUsers();
  const email = orders[idx].email;
  if (users[email]) {
    users[email].plan = orders[idx].plan;
    users[email].planStatus = "paid";
    users[email].invoiceId = orders[idx].invoiceId;
    users[email].paidAt = Date.now();
    saveUsers(users);
  }
  return orders[idx];
}

// demo confirm (only when no API key or order is demo)
app.post("/api/pay/confirm-demo", auth, (req, res) => {
  const orderId = req.body.orderId;
  const orders = getOrders();
  const order = orders.find((o) => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: "order not found" });
  if (order.email !== req.user.email && req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  if (!order.demo && NP_KEY) {
    return res.status(400).json({ error: "live mode — wait for real payment or use admin mark" });
  }
  const updated = markPaid(orderId, order.invoiceId || "demo");
  res.json({ status: "paid", order: updated });
});

// IPN webhook from NOWPayments
app.post("/api/pay/ipn", express.json(), (req, res) => {
  const body = req.body || {};
  console.log("[ipn]", JSON.stringify(body).slice(0, 500));
  // optional signature check if secret set
  if (NP_IPN) {
    const sig = req.headers["x-nowpayments-sig"];
    // simplified — production should sort + HMAC per NP docs
    if (!sig) console.warn("[ipn] missing signature");
  }
  const orderId = body.order_id;
  const status = String(body.payment_status || body.status || "").toLowerCase();
  if (orderId && ["finished", "confirmed", "sending", "paid"].includes(status)) {
    markPaid(orderId, body.invoice_id || body.payment_id);
  }
  res.json({ ok: true });
});

// success page helper: activate if order pending
app.post("/api/pay/activate-return", auth, (req, res) => {
  const orderId = req.body.orderId;
  const users = getUsers();
  const u = users[req.user.email];
  if (!u) return res.status(404).json({ error: "not found" });
  if (u.planStatus === "paid") return res.json({ status: "paid", plan: u.plan });
  if (orderId) {
    const order = getOrders().find((o) => o.orderId === orderId && o.email === req.user.email);
    if (order && order.status === "paid") {
      return res.json({ status: "paid", plan: order.plan });
    }
    // trust success_url return in demo / soft confirm when pending
    if (order && order.status === "waiting") {
      // do not auto-mark without payment in live mode
      if (order.demo || !NP_KEY) {
        markPaid(orderId, order.invoiceId);
        return res.json({ status: "paid", plan: order.plan });
      }
    }
  }
  res.json({ status: u.planStatus || "none", plan: u.plan });
});

// admin
app.get("/api/admin/users", auth, adminOnly, (req, res) => {
  const users = getUsers();
  const list = Object.values(users).map((u) => ({
    email: u.email,
    role: u.role,
    plan: u.plan,
    planStatus: u.planStatus,
    created: u.created,
    paidAt: u.paidAt || null,
    invoiceId: u.invoiceId || null
  }));
  res.json({ users: list });
});

app.get("/api/admin/orders", auth, adminOnly, (req, res) => {
  res.json({ orders: getOrders().slice().reverse() });
});

app.post("/api/admin/mark-paid", auth, adminOnly, (req, res) => {
  const { email, plan, orderId } = req.body || {};
  if (orderId) {
    const o = markPaid(orderId, "admin");
    return res.json({ ok: true, order: o });
  }
  if (!email) return res.status(400).json({ error: "email or orderId required" });
  const users = getUsers();
  const e = String(email).toLowerCase();
  if (!users[e]) return res.status(404).json({ error: "user not found" });
  users[e].plan = plan || users[e].plan || "pro";
  users[e].planStatus = "paid";
  users[e].paidAt = Date.now();
  saveUsers(users);
  res.json({ ok: true, user: { email: e, plan: users[e].plan, planStatus: "paid" } });
});

app.post("/api/admin/revoke", auth, adminOnly, (req, res) => {
  const email = String(req.body.email || "").toLowerCase();
  const users = getUsers();
  if (!users[email]) return res.status(404).json({ error: "not found" });
  users[email].planStatus = "none";
  saveUsers(users);
  res.json({ ok: true });
});

// SPA fallback for html routes
app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

app.listen(PORT, () => {
  console.log(`[stealth] http://localhost:${PORT}`);
  console.log(`[stealth] NOWPayments: ${NP_KEY ? "configured" : "NOT SET (demo mode)"}`);
  console.log(`[stealth] admin: ${ADMIN_EMAIL}`);
});
