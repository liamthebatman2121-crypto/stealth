const {
  getUsers, saveUsers, getOrders, saveOrders,
  hashPass, makeSalt, signToken, ensureAdmin,
  PLANS, markPaid, npRequest, cors, getAuth,
  ADMIN_EMAIL, NP_KEY, SITE_URL
} = require("../lib/store");
const crypto = require("crypto");

ensureAdmin();

function siteUrl(req) {
  if (SITE_URL) return SITE_URL;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return proto + "://" + host;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  // Resolve API subpath (supports Vercel rewrites)
  function resolvePath(req) {
    const q = req.query || {};
    if (q.__path) {
      let p = String(q.__path).split("?")[0];
      if (p.startsWith("/api")) p = p.slice(4) || "/";
      return p.startsWith("/") ? p : "/" + p;
    }
    let path = (req.url || "/").split("?")[0].replace(/\/$/, "") || "/";
    if (path.startsWith("/api")) path = path.slice(4) || "/";
    if (!path.startsWith("/")) path = "/" + path;
    // /api/index.js hit directly
    if (path === "/" || path === "/index.js" || path === "/index") {
      const referer = req.headers["x-forwarded-uri"] || req.headers["x-invoke-path"] || "";
      if (referer) {
        let r = String(referer).split("?")[0];
        if (r.startsWith("/api")) r = r.slice(4) || "/";
        if (r && r !== "/") return r.startsWith("/") ? r : "/" + r;
      }
    }
    return path === "/index.js" ? "/" : path;
  }

  // Vercel path: /api or /api/...
    const path = resolvePath(req);

  try {
    if (path === "/health" || path === "/") {
      return res.status(200).json({ ok: true, nowpayments: !!NP_KEY, keyChars: NP_KEY ? NP_KEY.length : 0 });
    }

    if (path === "/register" && req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const email = String(body.email || "").trim().toLowerCase();
      const pass = String(body.password || "");
      if (!email || pass.length < 6) return res.status(400).json({ error: "email and password (min 6) required" });
      const users = getUsers();
      if (users[email]) return res.status(409).json({ error: "account exists" });
      const s = makeSalt();
      users[email] = { email, salt: s, passHash: hashPass(pass, s), role: "user", plan: null, planStatus: "none", created: Date.now() };
      saveUsers(users);
      return res.status(200).json({ token: signToken({ email, role: "user" }), user: { email, role: "user", plan: null, planStatus: "none" } });
    }

    if (path === "/login" && req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const email = String(body.email || "").trim().toLowerCase();
      const pass = String(body.password || "");
      const users = getUsers();
      const user = users[email];
      if (!user || hashPass(pass, user.salt) !== user.passHash) return res.status(401).json({ error: "invalid credentials" });
      return res.status(200).json({
        token: signToken({ email, role: user.role || "user" }),
        user: { email, role: user.role || "user", plan: user.plan, planStatus: user.planStatus }
      });
    }

    if (path === "/me") {
      const auth = getAuth(req);
      if (!auth) return res.status(401).json({ error: "unauthorized" });
      const user = getUsers()[auth.email];
      if (!user) return res.status(404).json({ error: "not found" });
      return res.status(200).json({ email: user.email, role: user.role, plan: user.plan, planStatus: user.planStatus, invoiceId: user.invoiceId || null, paidAt: user.paidAt || null });
    }

    if (path === "/pay/create" && req.method === "POST") {
      const auth = getAuth(req);
      if (!auth) return res.status(401).json({ error: "unauthorized" });
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const planId = String(body.plan || "").toLowerCase();
      const plan = PLANS[planId];
      if (!plan) return res.status(400).json({ error: "invalid plan" });
      const users = getUsers();
      const user = users[auth.email];
      if (!user) return res.status(404).json({ error: "user not found" });
      if (user.planStatus === "paid") return res.status(200).json({ alreadyPaid: true, plan: user.plan });

      const orderId = "STL-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
      const order = { orderId, email: auth.email, plan: planId, price: plan.price, status: "waiting", invoiceId: null, invoiceUrl: null, created: Date.now() };

      if (!NP_KEY) {
        order.invoiceId = "demo-" + orderId;
        order.demo = true;
        const orders = getOrders(); orders.push(order); saveOrders(orders);
        user.plan = planId; user.planStatus = "pending"; user.pendingOrder = orderId; saveUsers(users);
        return res.status(200).json({ demo: true, orderId, amount: plan.price, plan: planId });
      }

      const payCurrency = String(body.pay_currency || "usdttrc20").toLowerCase();
      const base = siteUrl(req);
      const np = await npRequest("POST", "/payment", {
        price_amount: plan.price,
        price_currency: "usd",
        pay_currency: payCurrency,
        order_id: orderId,
        order_description: "Stealth " + plan.name + " lifetime",
        ipn_callback_url: base + "/api/pay/ipn"
      });

      if (np.status >= 400) {
        const inv = await npRequest("POST", "/invoice", {
          price_amount: plan.price, price_currency: "usd", order_id: orderId,
          order_description: "Stealth " + plan.name + " lifetime",
          success_url: base + "/dashboard.html?paid=1&order=" + encodeURIComponent(orderId),
          cancel_url: base + "/index.html#plans",
          ipn_callback_url: base + "/api/pay/ipn"
        });
        if (inv.status >= 400) return res.status(502).json({ error: "nowpayments failed", detail: inv.data || np.data });
        order.invoiceId = inv.data.id; order.invoiceUrl = inv.data.invoice_url;
        const orders = getOrders(); orders.push(order); saveOrders(orders);
        user.plan = planId; user.planStatus = "pending"; user.pendingOrder = orderId; user.invoiceId = inv.data.id; saveUsers(users);
        return res.status(200).json({ orderId, invoiceId: inv.data.id, invoiceUrl: inv.data.invoice_url, amount: plan.price, plan: planId, mode: "invoice" });
      }

      order.invoiceId = np.data.payment_id;
      order.paymentId = np.data.payment_id;
      order.payAddress = np.data.pay_address;
      order.payAmount = np.data.pay_amount;
      order.payCurrency = np.data.pay_currency;
      const orders = getOrders(); orders.push(order); saveOrders(orders);
      user.plan = planId; user.planStatus = "pending"; user.pendingOrder = orderId; user.invoiceId = np.data.payment_id; saveUsers(users);
      return res.status(200).json({
        orderId, paymentId: np.data.payment_id, payAddress: np.data.pay_address,
        payAmount: np.data.pay_amount, payCurrency: np.data.pay_currency,
        amount: plan.price, plan: planId, mode: "payment"
      });
    }

    if (path.startsWith("/pay/status/")) {
      const auth = getAuth(req);
      if (!auth) return res.status(401).json({ error: "unauthorized" });
      const orderId = decodeURIComponent(path.replace("/pay/status/", ""));
      const order = getOrders().find((o) => o.orderId === orderId);
      if (!order) return res.status(404).json({ error: "order not found" });
      if (order.email !== auth.email && auth.role !== "admin") return res.status(403).json({ error: "forbidden" });
      if (order.status === "paid") return res.status(200).json({ status: "paid", order });
      if (order.demo || !NP_KEY) return res.status(200).json({ status: order.status, order, demo: true });
      const pid = order.paymentId || order.invoiceId;
      if (pid) {
        let np = await npRequest("GET", "/payment/" + pid);
        if (np.status >= 400) np = await npRequest("GET", "/invoice/" + pid);
        if (np.status < 400) {
          const st = String(np.data.payment_status || np.data.status || "").toLowerCase();
          if (["finished", "confirmed", "sending", "paid"].includes(st)) {
            markPaid(orderId, pid);
            return res.status(200).json({ status: "paid", order: getOrders().find((o) => o.orderId === orderId) });
          }
          return res.status(200).json({ status: st || order.status, order, payAddress: order.payAddress, payAmount: order.payAmount });
        }
      }
      return res.status(200).json({ status: order.status, order });
    }

    if (path === "/pay/confirm-demo" && req.method === "POST") {
      const auth = getAuth(req);
      if (!auth) return res.status(401).json({ error: "unauthorized" });
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const order = getOrders().find((o) => o.orderId === body.orderId);
      if (!order) return res.status(404).json({ error: "order not found" });
      if (order.email !== auth.email && auth.role !== "admin") return res.status(403).json({ error: "forbidden" });
      if (!order.demo && NP_KEY) return res.status(400).json({ error: "live mode" });
      return res.status(200).json({ status: "paid", order: markPaid(order.orderId, order.invoiceId || "demo") });
    }

    if (path === "/pay/ipn" && req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const status = String(body.payment_status || body.status || "").toLowerCase();
      if (body.order_id && ["finished", "confirmed", "sending", "paid"].includes(status)) {
        markPaid(body.order_id, body.invoice_id || body.payment_id);
      }
      return res.status(200).json({ ok: true });
    }

    if (path === "/pay/activate-return" && req.method === "POST") {
      const auth = getAuth(req);
      if (!auth) return res.status(401).json({ error: "unauthorized" });
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const user = getUsers()[auth.email];
      if (!user) return res.status(404).json({ error: "not found" });
      if (user.planStatus === "paid") return res.status(200).json({ status: "paid", plan: user.plan });
      const order = getOrders().find((o) => o.orderId === body.orderId && o.email === auth.email);
      if (order && order.status === "paid") return res.status(200).json({ status: "paid", plan: order.plan });
      if (order && (order.demo || !NP_KEY) && order.status === "waiting") {
        markPaid(order.orderId, order.invoiceId);
        return res.status(200).json({ status: "paid", plan: order.plan });
      }
      return res.status(200).json({ status: user.planStatus || "none", plan: user.plan });
    }

    if (path === "/admin/users") {
      const auth = getAuth(req);
      if (!auth || auth.role !== "admin") return res.status(403).json({ error: "admin only" });
      const list = Object.values(getUsers()).map((u) => ({
        email: u.email, role: u.role, plan: u.plan, planStatus: u.planStatus,
        created: u.created, paidAt: u.paidAt || null, invoiceId: u.invoiceId || null
      }));
      return res.status(200).json({ users: list });
    }

    if (path === "/admin/orders") {
      const auth = getAuth(req);
      if (!auth || auth.role !== "admin") return res.status(403).json({ error: "admin only" });
      return res.status(200).json({ orders: getOrders().slice().reverse() });
    }

    if (path === "/admin/mark-paid" && req.method === "POST") {
      const auth = getAuth(req);
      if (!auth || auth.role !== "admin") return res.status(403).json({ error: "admin only" });
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      if (body.orderId) return res.status(200).json({ ok: true, order: markPaid(body.orderId, "admin") });
      const email = String(body.email || "").toLowerCase();
      const users = getUsers();
      if (!users[email]) return res.status(404).json({ error: "user not found" });
      users[email].plan = body.plan || users[email].plan || "pro";
      users[email].planStatus = "paid";
      users[email].paidAt = Date.now();
      saveUsers(users);
      return res.status(200).json({ ok: true });
    }

    if (path === "/admin/revoke" && req.method === "POST") {
      const auth = getAuth(req);
      if (!auth || auth.role !== "admin") return res.status(403).json({ error: "admin only" });
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const email = String(body.email || "").toLowerCase();
      const users = getUsers();
      if (!users[email]) return res.status(404).json({ error: "not found" });
      users[email].planStatus = "none";
      saveUsers(users);
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: "not found", path });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error", message: e.message });
  }
};
