const { NP_KEY, cors } = require("../lib/store");
module.exports = function handler(req, res) {
  cors(res);
  res.status(200).json({ ok: true, nowpayments: !!NP_KEY, keyChars: NP_KEY ? NP_KEY.length : 0 });
};
