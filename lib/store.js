const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.VERCEL
  ? path.join("/tmp", "stealth-data")
  : path.join(__dirname, "..", "data");

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error("data dir", e.message);
  }
}
ensureDir();

const USERS_FILE = path.join(DATA_DIR, "users.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

function readJson(f, fb) {
  try {
    if (!fs.existsSync(f)) return fb;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return fb;
  }
}
function writeJson(f, d) {
  try {
    ensureDir();
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
  } catch (e) {
    console.error("write", e.message);
  }
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

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@stealth.local").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change_this_password";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_secret";
const NP_KEY = (process.env.NOWPAYMENTS_API_KEY || "").trim();
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");

function hashPass(pass, salt) {
  return crypto.pbkdf2Sync(pass, salt, 100000, 32, "sha256").toString("hex");
}
function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function signToken(payload) {
  const body = Buffer.from(
    JSON.stringify(Object.assign({}, payload, { exp: Date.now() + 7 * 864e5 }))
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verifyToken(token) {
  if (!token || token.indexOf(".") === -1) return null;
  const parts = token.split(".");
  const body = parts[0];
  const sig = parts[1];
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

function ensureAdmin() {
  try {
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
    }
  } catch (e) {
    console.error("ensureAdmin", e.message);
  }
}

const PLANS = {
  starter: { id: "starter", name: "Starter", price: 149 },
  pro: { id: "pro", name: "Pro", price: 249 },
  elite: { id: "elite", name: "Elite", price: 549 }
};

function markPaid(orderId, invoiceId) {
  const orders = getOrders();
  const idx = orders.findIndex(function (o) {
    return o.orderId === orderId;
  });
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

async function npRequest(method, apiPath, body) {
  const data = body ? JSON.stringify(body) : null;
  const res = await fetch("https://api.nowpayments.io/v1" + apiPath, {
    method: method,
    headers: {
      "x-api-key": NP_KEY,
      "Content-Type": "application/json"
    },
    body: data
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, data: json };
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function getAuth(req) {
  const h = req.headers.authorization || "";
  const token = h.indexOf("Bearer ") === 0 ? h.slice(7) : "";
  return verifyToken(token);
}

module.exports = {
  getUsers: getUsers,
  saveUsers: saveUsers,
  getOrders: getOrders,
  saveOrders: saveOrders,
  hashPass: hashPass,
  makeSalt: makeSalt,
  signToken: signToken,
  verifyToken: verifyToken,
  ensureAdmin: ensureAdmin,
  PLANS: PLANS,
  markPaid: markPaid,
  npRequest: npRequest,
  cors: cors,
  getAuth: getAuth,
  ADMIN_EMAIL: ADMIN_EMAIL,
  ADMIN_PASSWORD: ADMIN_PASSWORD,
  NP_KEY: NP_KEY,
  SITE_URL: SITE_URL,
  SESSION_SECRET: SESSION_SECRET
};
