const { getUsers, getAuth, cors, ensureAdmin } = require("../lib/store");
ensureAdmin();
module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: "unauthorized" });
  const user = getUsers()[auth.email];
  if (!user) return res.status(404).json({ error: "not found" });
  return res.status(200).json({ email: user.email, role: user.role, plan: user.plan, planStatus: user.planStatus, invoiceId: user.invoiceId || null, paidAt: user.paidAt || null });
};
