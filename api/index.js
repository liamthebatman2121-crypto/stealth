const { cors, NP_KEY, ensureAdmin } = require("../lib/store");
ensureAdmin();
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  return res.status(200).json({
    ok: true,
    nowpayments: !!NP_KEY,
    message: "Stealth API root. Use /api/health, /api/login, /api/register, /api/pay/create"
  });
};
