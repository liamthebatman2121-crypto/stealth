const { getOrders, getAuth, cors, markPaid, npRequest, NP_KEY, ensureAdmin } = require("../../lib/store");
ensureAdmin();
module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: "unauthorized" });
  const orderId = (req.query && (req.query.orderId || req.query.id)) || "";
  // also support /api/pay/status/ORDER via rewrite query
  const id = orderId || (req.query && req.query.path) || "";
  let oid = id;
  if (!oid && req.url) {
    const m = req.url.match(/status[/=]([^?&/]+)/);
    if (m) oid = decodeURIComponent(m[1]);
  }
  if (!oid) return res.status(400).json({ error: "orderId required" });
  const order = getOrders().find((o) => o.orderId === oid);
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
        markPaid(oid, pid);
        return res.status(200).json({ status: "paid", order: getOrders().find((o) => o.orderId === oid) });
      }
      return res.status(200).json({ status: st || order.status, order });
    }
  }
  return res.status(200).json({ status: order.status, order });
};
