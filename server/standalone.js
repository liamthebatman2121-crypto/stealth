/**
 * Zero-dependency Stealth API + static server (Node 18+)
 * Usage: node server/standalone.js
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const ENV_PATH = path.join(ROOT, ".env");

function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_PATH)) {
    fs.readFileSync(ENV_PATH, "utf8").split("\n").forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    });
  }
  return env;
}
const ENV = loadEnv();
const PORT = Number(ENV.PORT || 8787);
const SITE_URL = (ENV.SITE_URL || ("http://localhost:" + PORT)).replace(/\/$/, "");
const NP_KEY = (ENV.NOWPAYMENTS_API_KEY || "").trim();
const ADMIN_EMAIL = (ENV.ADMIN_EMAIL || "admin@stealth.local").toLowerCase();
const ADMIN_PASSWORD = ENV.ADMIN_PASSWORD || "change_this_password";
const SESSION_SECRET = ENV.SESSION_SECRET || "dev_secret";

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
const USERS_FILE = path.join(DATA, "users.json");
const ORDERS_FILE = path.join(DATA, "orders.json");

function readJson(f, fb) {
  try {
    if (!fs.existsSync(f)) return fb;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    return fb;
  }
}
function writeJson(f, d) {
  fs.writeFileSync(f, JSON.stringify(d, null, 2));
}
function getUsers() { return readJson(USERS_FILE, {}); }
function saveUsers(u) { writeJson(USERS_FILE, u); }
function getOrders() { return readJson(ORDERS_FILE, []); }
function saveOrders(o) { writeJson(ORDERS_FILE, o); }

function hashPass(pass, s) {
  return crypto.pbkdf2Sync(pass, s, 100000, 32, "sha256").toString("hex");
}
function makeSalt() { return crypto.randomBytes(16).toString("hex"); }
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(Object.assign({}, payload, { exp: Date.now() + 7 * 864e5 }))).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verifyToken(token) {
  if (!token || token.indexOf(".") === -1) return null;
  const parts = token.split(".");
  const body = parts[0], sig = parts[1];
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (sig !== expect) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch (e) { return null; }
}

const PLANS = {
  starter: { id: "starter", name: "Starter", price: 149 },
  pro: { id: "pro", name: "Pro", price: 249 },
  elite: { id: "elite", name: "Elite", price: 549 }
};

(function seed() {
  const users = getUsers();
  if (!users[ADMIN_EMAIL]) {
    const s = makeSalt();
    users[ADMIN_EMAIL] = {
      email: ADMIN_EMAIL,
      salt: s,
      passHash: hashPass(ADMIN_PASSWORD, s),
      role: "admin",
      plan: "elite",
      planStatus: "paid",
      created: Date.now(),
      paidAt: Date.now()
    };
    saveUsers(users);
    console.log("[stealth] admin:", ADMIN_EMAIL);
  }
})();

function parseBody(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); }
    });
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(body);
}

function getAuth(req) {
  const h = req.headers.authorization || "";
  const token = h.indexOf("Bearer ") === 0 ? h.slice(7) : "";
  return verifyToken(token);
}

function markPaid(orderId, invoiceId) {
  const orders = getOrders();
  const idx = orders.findIndex(function (o) { return o.orderId === orderId; });
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

function npRequest(method, apiPath, body) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "x-api-key": NP_KEY, "Content-Type": "application/json" };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    const req = https.request({
      hostname: "api.nowpayments.io",
      path: "/v1" + apiPath,
      method: method,
      headers: headers
    }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
        resolve({ status: res.statusCode, data: json });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function serveStatic(req, res, pathname) {
  let p = pathname === "/" ? "/index.html" : pathname;
  p = decodeURIComponent(p.split("?")[0]);
  if (p.indexOf("..") !== -1) { res.writeHead(400); return res.end("bad"); }
  const file = path.join(ROOT, p);
  if (file.indexOf(ROOT) !== 0 || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("not found");
  }
  const ext = path.extname(file);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, SITE_URL);
  const pathname = u.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    return res.end();
  }
  try {
    if (pathname === "/api/health") return send(res, 200, { ok: true, nowpayments: !!NP_KEY, keyChars: NP_KEY ? NP_KEY.length : 0, site: SITE_URL });
    if (pathname === "/api/config-public") return send(res, 200, { siteUrl: SITE_URL, plans: PLANS, nowpaymentsConfigured: !!NP_KEY });

    if (pathname === "/api/register" && req.method === "POST") {
      const body = await parseBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const pass = String(body.password || "");
      if (!email || pass.length < 6) return send(res, 400, { error: "email and password (min 6) required" });
      const users = getUsers();
      if (users[email]) return send(res, 409, { error: "account exists" });
      const s = makeSalt();
      users[email] = { email: email, salt: s, passHash: hashPass(pass, s), role: "user", plan: null, planStatus: "none", created: Date.now() };
      saveUsers(users);
      return send(res, 200, { token: signToken({ email: email, role: "user" }), user: { email: email, role: "user", plan: null, planStatus: "none" } });
    }

    if (pathname === "/api/login" && req.method === "POST") {
      const body = await parseBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const pass = String(body.password || "");
      const users = getUsers();
      const user = users[email];
      if (!user || hashPass(pass, user.salt) !== user.passHash) return send(res, 401, { error: "invalid credentials" });
      return send(res, 200, {
        token: signToken({ email: email, role: user.role || "user" }),
        user: { email: email, role: user.role || "user", plan: user.plan, planStatus: user.planStatus }
      });
    }

    if (pathname === "/api/me") {
      const auth = getAuth(req);
      if (!auth) return send(res, 401, { error: "unauthorized" });
      const user = getUsers()[auth.email];
      if (!user) return send(res, 404, { error: "not found" });
      return send(res, 200, { email: user.email, role: user.role, plan: user.plan, planStatus: user.planStatus, invoiceId: user.invoiceId || null, paidAt: user.paidAt || null });
    }

    if (pathname === "/api/pay/create" && req.method === "POST") {
      const auth = getAuth(req);
      if (!auth) return send(res, 401, { error: "unauthorized" });
      const body = await parseBody(req);
      const planId = String(body.plan || "").toLowerCase();
      const plan = PLANS[planId];
      if (!plan) return send(res, 400, { error: "invalid plan" });
      const users = getUsers();
      const user = users[auth.email];
      if (!user) return send(res, 404, { error: "user not found" });
      if (user.planStatus === "paid") return send(res, 200, { alreadyPaid: true, plan: user.plan });
      const orderId = "STL-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
      const order = { orderId: orderId, email: auth.email, plan: planId, price: plan.price, status: "waiting", invoiceId: null, invoiceUrl: null, created: Date.now() };
      if (!NP_KEY) {
        order.invoiceId = "demo-" + orderId;
        order.demo = true;
        const orders = getOrders(); orders.push(order); saveOrders(orders);
        user.plan = planId; user.planStatus = "pending"; user.pendingOrder = orderId; saveUsers(users);
        return send(res, 200, { demo: true, orderId: orderId, amount: plan.price, plan: planId });
      }
      const payCurrency = String(body.pay_currency || "usdttrc20").toLowerCase();
      // Direct payment (like CTRADER) — real deposit address + amount for QR
      const np = await npRequest("POST", "/payment", {
        price_amount: plan.price,
        price_currency: "usd",
        pay_currency: payCurrency,
        order_id: orderId,
        order_description: "Stealth " + plan.name + " lifetime",
        ipn_callback_url: SITE_URL + "/api/pay/ipn"
      });
      if (np.status >= 400) {
        // fallback to invoice hosted page
        const successUrl = SITE_URL + "/dashboard.html?paid=1&order=" + encodeURIComponent(orderId);
        const cancelUrl = SITE_URL + "/index.html#plans";
        const inv = await npRequest("POST", "/invoice", {
          price_amount: plan.price, price_currency: "usd", order_id: orderId,
          order_description: "Stealth " + plan.name + " lifetime",
          success_url: successUrl, cancel_url: cancelUrl, ipn_callback_url: SITE_URL + "/api/pay/ipn"
        });
        if (inv.status >= 400) return send(res, 502, { error: "nowpayments failed", detail: inv.data || np.data });
        order.invoiceId = inv.data.id; order.invoiceUrl = inv.data.invoice_url;
        const orders = getOrders(); orders.push(order); saveOrders(orders);
        user.plan = planId; user.planStatus = "pending"; user.pendingOrder = orderId; user.invoiceId = inv.data.id; saveUsers(users);
        return send(res, 200, { orderId: orderId, invoiceId: inv.data.id, invoiceUrl: inv.data.invoice_url, amount: plan.price, plan: planId, mode: "invoice" });
      }
      order.invoiceId = np.data.payment_id;
      order.paymentId = np.data.payment_id;
      order.payAddress = np.data.pay_address;
      order.payAmount = np.data.pay_amount;
      order.payCurrency = np.data.pay_currency;
      order.invoiceUrl = null;
      const orders = getOrders(); orders.push(order); saveOrders(orders);
      user.plan = planId; user.planStatus = "pending"; user.pendingOrder = orderId; user.invoiceId = np.data.payment_id; saveUsers(users);
      return send(res, 200, {
        orderId: orderId,
        paymentId: np.data.payment_id,
        payAddress: np.data.pay_address,
        payAmount: np.data.pay_amount,
        payCurrency: np.data.pay_currency,
        amount: plan.price,
        plan: planId,
        mode: "payment"
      });
    }

    if (pathname.indexOf("/api/pay/status/") === 0 && req.method === "GET") {
      const auth = getAuth(req);
      if (!auth) return send(res, 401, { error: "unauthorized" });
      const orderId = decodeURIComponent(pathname.replace("/api/pay/status/", ""));
      const order = getOrders().find(function (o) { return o.orderId === orderId; });
      if (!order) return send(res, 404, { error: "order not found" });
      if (order.email !== auth.email && auth.role !== "admin") return send(res, 403, { error: "forbidden" });
      if (order.status === "paid") return send(res, 200, { status: "paid", order: order });
      if (order.demo || !NP_KEY) return send(res, 200, { status: order.status, order: order, demo: true });
      const pid = order.paymentId || order.invoiceId;
      if (pid) {
        // prefer payment status endpoint (CTRADER style)
        let np = await npRequest("GET", "/payment/" + pid);
        if (np.status >= 400) np = await npRequest("GET", "/invoice/" + pid);
        if (np.status < 400) {
          const st = String(np.data.payment_status || np.data.status || "").toLowerCase();
          if (["finished", "confirmed", "sending", "paid"].indexOf(st) !== -1) {
            markPaid(orderId, pid);
            return send(res, 200, { status: "paid", order: getOrders().find(function (o) { return o.orderId === orderId; }) });
          }
          return send(res, 200, { status: st || order.status, order: order, payAddress: order.payAddress, payAmount: order.payAmount });
        }
      }
      return send(res, 200, { status: order.status, order: order });
    }

    if (pathname === "/api/pay/confirm-demo" && req.method === "POST") {
      const auth = getAuth(req);
      if (!auth) return send(res, 401, { error: "unauthorized" });
      const body = await parseBody(req);
      const order = getOrders().find(function (o) { return o.orderId === body.orderId; });
      if (!order) return send(res, 404, { error: "order not found" });
      if (order.email !== auth.email && auth.role !== "admin") return send(res, 403, { error: "forbidden" });
      if (!order.demo && NP_KEY) return send(res, 400, { error: "live mode" });
      return send(res, 200, { status: "paid", order: markPaid(order.orderId, order.invoiceId || "demo") });
    }

    if (pathname === "/api/pay/ipn" && req.method === "POST") {
      const body = await parseBody(req);
      console.log("[ipn]", JSON.stringify(body).slice(0, 400));
      const status = String(body.payment_status || body.status || "").toLowerCase();
      if (body.order_id && ["finished", "confirmed", "sending", "paid"].indexOf(status) !== -1) {
        markPaid(body.order_id, body.invoice_id || body.payment_id);
      }
      return send(res, 200, { ok: true });
    }

    if (pathname === "/api/pay/activate-return" && req.method === "POST") {
      const auth = getAuth(req);
      if (!auth) return send(res, 401, { error: "unauthorized" });
      const body = await parseBody(req);
      const user = getUsers()[auth.email];
      if (!user) return send(res, 404, { error: "not found" });
      if (user.planStatus === "paid") return send(res, 200, { status: "paid", plan: user.plan });
      const order = getOrders().find(function (o) { return o.orderId === body.orderId && o.email === auth.email; });
      if (order && order.status === "paid") return send(res, 200, { status: "paid", plan: order.plan });
      if (order && (order.demo || !NP_KEY) && order.status === "waiting") {
        markPaid(order.orderId, order.invoiceId);
        return send(res, 200, { status: "paid", plan: order.plan });
      }
      return send(res, 200, { status: user.planStatus || "none", plan: user.plan });
    }

    if (pathname === "/api/admin/users") {
      const auth = getAuth(req);
      if (!auth || auth.role !== "admin") return send(res, 403, { error: "admin only" });
      const list = Object.values(getUsers()).map(function (u) {
        return { email: u.email, role: u.role, plan: u.plan, planStatus: u.planStatus, created: u.created, paidAt: u.paidAt || null, invoiceId: u.invoiceId || null };
      });
      return send(res, 200, { users: list });
    }
    if (pathname === "/api/admin/orders") {
      const auth = getAuth(req);
      if (!auth || auth.role !== "admin") return send(res, 403, { error: "admin only" });
      return send(res, 200, { orders: getOrders().slice().reverse() });
    }
    if (pathname === "/api/admin/mark-paid" && req.method === "POST") {
      const auth = getAuth(req);
      if (!auth || auth.role !== "admin") return send(res, 403, { error: "admin only" });
      const body = await parseBody(req);
      if (body.orderId) return send(res, 200, { ok: true, order: markPaid(body.orderId, "admin") });
      const email = String(body.email || "").toLowerCase();
      const users = getUsers();
      if (!users[email]) return send(res, 404, { error: "user not found" });
      users[email].plan = body.plan || users[email].plan || "pro";
      users[email].planStatus = "paid";
      users[email].paidAt = Date.now();
      saveUsers(users);
      return send(res, 200, { ok: true });
    }
    if (pathname === "/api/admin/revoke" && req.method === "POST") {
      const auth = getAuth(req);
      if (!auth || auth.role !== "admin") return send(res, 403, { error: "admin only" });
      const body = await parseBody(req);
      const email = String(body.email || "").toLowerCase();
      const users = getUsers();
      if (!users[email]) return send(res, 404, { error: "not found" });
      users[email].planStatus = "none";
      saveUsers(users);
      return send(res, 200, { ok: true });
    }

    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "server error", message: e.message });
  }
});

server.listen(PORT, function () {
  console.log("[stealth] full stack http://localhost:" + PORT);
  console.log("[stealth] NOWPayments:", NP_KEY ? "configured" : "NOT SET (demo)");
  console.log("[stealth] admin:", ADMIN_EMAIL);
});
