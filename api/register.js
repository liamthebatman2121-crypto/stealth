const { getUsers, saveUsers, hashPass, makeSalt, signToken, ensureAdmin, cors } = require("../lib/store");
ensureAdmin();
module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
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
};
