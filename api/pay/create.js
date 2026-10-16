const crypto = require("crypto");
const {
  getUsers, saveUsers, getOrders, saveOrders, getAuth, cors, ensureAdmin,
  PLANS, npRequest, NP_KEY, SITE_URL
} = require("../../lib/store");
ensureAdmin();

function siteUrl(req) {
  if (SITE_URL) return SITE_URL;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return proto + "://" + host;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
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
  const order = { orderId, email: auth.email, plan: planId, price: plan.price, status: "waiting", created: Date.now() };

  if (!NP_KEY) {
    order.invoiceId = "demo-" + orderId; order.demo = true;
    const orders = getOrders(); orders.push(order); saveOrders(orders);
    user.plan = planId; user.planStatus = "pending"; user.pendingOrder = orderId; saveUsers(users);
    return res.status(200).json({ demo: true, orderId, amount: plan.price, plan: planId });
  }

  const payCurrency = String(body.pay_currency || "usdttrc20").toLowerCase();
  const base = siteUrl(req);
  const np = await npRequest("POST", "/payment", {
    price_amount: plan.price, price_currency: "usd", pay_currency: payCurrency,
    order_id: orderId, order_description: "Stealth " + plan.name + " lifetime",
    ipn_callback_url: base + "/api/pay/ipn"
  });

  if (np.status >= 400) {
    const inv = await npRequest("POST", "/invoice", {
      price_amount: plan.price, price_currency: "usd", order_id: orderId,
      order_description: "Stealth " + plan.name + " lifetime",
      success_url: base + "/dashboard.html?paid=1&order=" + encodeURIComponent(orderId),
      cancel_url: base + "/index.html#plans", ipn_callback_url: base + "/api/pay/ipn"
    });
    if (inv.status >= 400) return res.status(502).json({ error: "nowpayments failed", detail: inv.data || np.data });
    order.invoiceId = inv.data.id; order.invoiceUrl = inv.data.invoice_url;
    const orders = getOrders(); orders.push(order); saveOrders(orders);
    user.plan = planId; user.planStatus = "pending"; user.pendingOrder = orderId; user.invoiceId = inv.data.id; saveUsers(users);
    return res.status(200).json({ orderId, invoiceId: inv.data.id, invoiceUrl: inv.data.invoice_url, amount: plan.price, plan: planId, mode: "invoice" });
  }

  order.invoiceId = np.data.payment_id; order.paymentId = np.data.payment_id;
  order.payAddress = np.data.pay_address; order.payAmount = np.data.pay_amount; order.payCurrency = np.data.pay_currency;
  const orders = getOrders(); orders.push(order); saveOrders(orders);
  user.plan = planId; user.planStatus = "pending"; user.pendingOrder = orderId; user.invoiceId = np.data.payment_id; saveUsers(users);
  return res.status(200).json({
    orderId, paymentId: np.data.payment_id, payAddress: np.data.pay_address,
    payAmount: np.data.pay_amount, payCurrency: np.data.pay_currency,
    amount: plan.price, plan: planId, mode: "payment"
  });
};
