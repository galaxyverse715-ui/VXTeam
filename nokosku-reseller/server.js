require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.NOMOROTP_API_KEY || "";
const API_BASE = process.env.NOMOROTP_BASE_URL || "https://api.nomorotp.id/";
const MARGIN = Math.max(0, Number(process.env.RESELLER_MARGIN_PERCENT || 25));
const db = new Database(path.join(__dirname, "data.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer',
 balance INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
 activation_id TEXT UNIQUE NOT NULL, service TEXT NOT NULL, country TEXT NOT NULL,
 phone TEXT, cost INTEGER NOT NULL, sale_price INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', otp_code TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS ledger (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
 amount INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
const count = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n;
if (!count) {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "";
  if (!password || password.includes("ganti_password")) {
    console.warn("PERINGATAN: set ADMIN_PASSWORD kuat di .env sebelum dipakai online.");
  }
  const hash = bcrypt.hashSync(password || crypto.randomBytes(24).toString("hex"), 12);
  db.prepare("INSERT OR IGNORE INTO users(username,password_hash,role,balance) VALUES(?,?, 'admin', 0)")
    .run(username, hash);
}
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "30kb" }));
app.use(express.urlencoded({ extended: false, limit: "30kb" }));
app.use(session({
  name: "nokosku.sid",
  secret: process.env.SESSION_SECRET || "dev-only-change-this-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 1000*60*60*12 }
}));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public")));

function userView(u) {
  return { id: u.id, username: u.username, role: u.role, balance: u.balance };
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Silakan login terlebih dahulu." });
  const user = db.prepare("SELECT id,username,role,balance FROM users WHERE id=?").get(req.session.userId);
  if (!user) { req.session.destroy(()=>{}); return res.status(401).json({ error: "Sesi tidak valid." }); }
  req.user = user; next();
}
function requireAdmin(req,res,next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Khusus admin." });
  next();
}
async function provider(action, params={}, method="GET") {
  if (!API_KEY) throw new Error("API provider belum dikonfigurasi. Isi NOMOROTP_API_KEY di .env.");
  const url = new URL(API_BASE);
  url.searchParams.set("action", action);
  if (method === "GET") for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const options = { method, headers: { "X-API-Key": API_KEY, "Accept": "application/json" } };
  if (method !== "GET") {
    options.headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!=="").map(([k,v])=>[k,String(v)])).toString();
  }
  const response = await fetch(url, options);
  const data = await response.json().catch(()=>({success:false,error:"BAD_RESPONSE"}));
  if (!response.ok || data.success === false) {
    const e = new Error(data.message || data.error || `Provider HTTP ${response.status}`);
    e.status = response.status; throw e;
  }
  return data;
}
function safeError(res, err) {
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
  res.status(status).json({ error: err.message || "Permintaan ke provider gagal." });
}

app.get("/api/me", (req,res) => {
  if (!req.session.userId) return res.json({ user: null });
  const u = db.prepare("SELECT id,username,role,balance FROM users WHERE id=?").get(req.session.userId);
  res.json({ user: u ? userView(u) : null });
});
app.post("/api/register", rateLimit({windowMs:15*60*1000,limit:8}), async (req,res) => {
  if (process.env.ALLOW_PUBLIC_REGISTER === "false") return res.status(403).json({error:"Registrasi publik sedang dimatikan."});
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({error:"Username 3–24 karakter: huruf kecil, angka, underscore."});
  if (password.length < 10) return res.status(400).json({error:"Password minimal 10 karakter."});
  try {
    const hash = await bcrypt.hash(password, 12);
    const info = db.prepare("INSERT INTO users(username,password_hash,role,balance) VALUES(?,?,'customer',0)").run(username,hash);
    req.session.userId = Number(info.lastInsertRowid);
    res.json({user:userView(db.prepare("SELECT id,username,role,balance FROM users WHERE id=?").get(req.session.userId))});
  } catch { res.status(409).json({error:"Username sudah digunakan."}); }
});
app.post("/api/login", rateLimit({windowMs:15*60*1000,limit:10}), async (req,res) => {
  const username = String(req.body.username||"").trim().toLowerCase();
  const password = String(req.body.password||"");
  const u = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (!u || !(await bcrypt.compare(password,u.password_hash))) return res.status(401).json({error:"Username atau password salah."});
  req.session.regenerate(err => {
    if (err) return res.status(500).json({error:"Gagal membuat sesi."});
    req.session.userId = u.id;
    res.json({user:userView(u)});
  });
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get("/api/catalog", requireAuth, async (req,res) => {
  try {
    const server = String(req.query.server || "plus");
    const [services, countries, prices] = await Promise.all([
      provider("getServices",{server}), provider("getCountries",{server}), provider("getPrices",{server})
    ]);
    res.json({server, services:services.services||{}, countries:countries.countries||{}, prices:prices.prices||{}, marginPercent:MARGIN});
  } catch(e) { safeError(res,e); }
});
app.get("/api/balance", requireAuth, async (req,res) => {
  try { const p = await provider("getBalance"); res.json({customerBalance:req.user.balance, providerBalance:p.balance}); }
  catch(e) { safeError(res,e); }
});
app.post("/api/order", requireAuth, async (req,res) => {
  const service = String(req.body.service||"").trim();
  const country = String(req.body.country||"").trim();
  const server = String(req.body.server||"plus").trim();
  const operator = String(req.body.operator||"").trim();
  if (!/^[a-zA-Z0-9_-]{1,20}$/.test(service) || !/^\d{1,5}$/.test(country) || !/^[a-zA-Z0-9_-]{1,20}$/.test(server))
    return res.status(400).json({error:"Parameter layanan/negara/server tidak valid."});
  try {
    const prices = await provider("getPrices",{server,country,service});
    const row = prices.prices?.[service] || prices.prices?.[country]?.[service];
    const cost = Number(row?.cost);
    if (!Number.isFinite(cost) || cost < 0) return res.status(409).json({error:"Harga layanan tidak tersedia."});
    const salePrice = Math.ceil(cost * (1 + MARGIN/100));
    const fresh = db.prepare("SELECT balance FROM users WHERE id=?").get(req.user.id);
    if (fresh.balance < salePrice) return res.status(402).json({error:`Saldo pelanggan kurang. Harga jual: Rp${salePrice.toLocaleString("id-ID")}`});
    // Debit wallet first. If upstream fails, credit it back.
    const debit = db.transaction(() => {
      const current = db.prepare("SELECT balance FROM users WHERE id=?").get(req.user.id);
      if (current.balance < salePrice) throw new Error("Saldo pelanggan tidak cukup.");
      db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(salePrice,req.user.id);
      db.prepare("INSERT INTO ledger(user_id,amount,kind,note) VALUES(?,?,?,?)").run(req.user.id,-salePrice,"order","Debit order");
    });
    debit();
    let result;
    try { result = await provider("getNumber",{server,service,country,operator},"POST"); }
    catch(e) {
      db.transaction(()=>{
        db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(salePrice,req.user.id);
        db.prepare("INSERT INTO ledger(user_id,amount,kind,note) VALUES(?,?,?,?)").run(req.user.id,salePrice,"refund","Refund otomatis: provider gagal");
      })();
      throw e;
    }
    const a = result.activation;
    if (!a?.id) throw new Error("Provider tidak mengembalikan ID aktivasi. Hubungi admin untuk rekonsiliasi.");
    db.prepare("INSERT INTO orders(user_id,activation_id,service,country,phone,cost,sale_price,status) VALUES(?,?,?,?,?,?,?,'pending')")
      .run(req.user.id,String(a.id),service,country,String(a.phone||""),cost,salePrice);
    res.json({order:{id:a.id,phone:a.phone||null,cost,salePrice,expiresIn:a.expires_in||1200,status:"pending"}});
  } catch(e) { safeError(res,e); }
});
app.get("/api/orders", requireAuth, (req,res) => {
  const rows = req.user.role==="admin"
    ? db.prepare("SELECT o.*,u.username FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 100").all()
    : db.prepare("SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 100").all(req.user.id);
  res.json({orders:rows});
});
app.get("/api/order/:id/status", requireAuth, async (req,res) => {
  const order = db.prepare("SELECT * FROM orders WHERE activation_id=?").get(String(req.params.id));
  if (!order || (order.user_id !== req.user.id && req.user.role!=="admin")) return res.status(404).json({error:"Pesanan tidak ditemukan."});
  try {
    const s = await provider("getStatus",{id:order.activation_id});
    const status = String(s.status || "pending");
    const code = s.code ? String(s.code) : null;
    db.prepare("UPDATE orders SET status=?,otp_code=COALESCE(?,otp_code) WHERE activation_id=?").run(status,code,order.activation_id);
    res.json({id:order.activation_id,status,code});
  } catch(e) { safeError(res,e); }
});
app.post("/api/order/:id/cancel", requireAuth, async (req,res) => {
  const order = db.prepare("SELECT * FROM orders WHERE activation_id=?").get(String(req.params.id));
  if (!order || (order.user_id !== req.user.id && req.user.role!=="admin")) return res.status(404).json({error:"Pesanan tidak ditemukan."});
  try {
    const result = await provider("cancelActivation",{id:order.activation_id},"POST");
    const refund = Number(result.refund || 0);
    if (refund > 0) {
      db.transaction(()=>{
        db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(order.sale_price,order.user_id);
        db.prepare("INSERT INTO ledger(user_id,amount,kind,note) VALUES(?,?,?,?)").run(order.user_id,order.sale_price,"refund","Pembatalan aktivasi");
        db.prepare("UPDATE orders SET status='cancelled' WHERE activation_id=?").run(order.activation_id);
      })();
    }
    res.json({ok:true,providerRefund:refund,customerRefund:refund>0?order.sale_price:0});
  } catch(e) { safeError(res,e); }
});

// Provider deposit only tops up the OWNER's provider balance, not customer wallet.
app.post("/api/provider-deposit", requireAuth, requireAdmin, async (req,res) => {
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount < 10000 || amount > 10000000) return res.status(400).json({error:"Nominal Rp10.000–Rp10.000.000."});
  try { res.json(await provider("createDeposit",{amount,method:"qris"},"POST")); }
  catch(e) { safeError(res,e); }
});
app.get("/api/provider-deposit/:id", requireAuth, requireAdmin, async (req,res) => {
  try { res.json(await provider("checkDeposit",{id:String(req.params.id)})); }
  catch(e) { safeError(res,e); }
});
app.get("/api/admin/users", requireAuth, requireAdmin, (req,res) => {
  res.json({users:db.prepare("SELECT id,username,role,balance,created_at FROM users ORDER BY id DESC").all()});
});
app.post("/api/admin/wallet", requireAuth, requireAdmin, (req,res) => {
  const userId = Number(req.body.userId), amount = Number(req.body.amount);
  const note = String(req.body.note||"Penyesuaian admin").slice(0,160);
  if (!Number.isInteger(userId) || !Number.isInteger(amount) || amount===0 || Math.abs(amount)>100000000) return res.status(400).json({error:"User ID/nominal tidak valid."});
  const target = db.prepare("SELECT id,username,balance FROM users WHERE id=?").get(userId);
  if (!target) return res.status(404).json({error:"User tidak ditemukan."});
  if (target.balance + amount < 0) return res.status(400).json({error:"Saldo tidak boleh negatif."});
  db.transaction(()=>{
    db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(amount,userId);
    db.prepare("INSERT INTO ledger(user_id,amount,kind,note) VALUES(?,?,?,?)").run(userId,amount,"admin_adjustment",note);
  })();
  res.json({ok:true,userId,balance:target.balance+amount});
});
app.get("/api/admin/ledger", requireAuth, requireAdmin, (req,res) => {
  res.json({ledger:db.prepare("SELECT l.*,u.username FROM ledger l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 200").all()});
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`NOKOSKU berjalan di http://localhost:${PORT}`));
