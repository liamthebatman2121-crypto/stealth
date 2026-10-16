const { getUsers, hashPass, signToken, ensureAdmin, cors } = require("../lib/store");
ensureAdmin();
module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
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
};
