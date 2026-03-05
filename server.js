require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "bbq-pos-jwt-secret-2024";

// ── Middleware xác thực JWT ──────────────────
function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Chưa đăng nhập" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token không hợp lệ hoặc đã hết hạn" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res
        .status(403)
        .json({ error: "Không có quyền thực hiện thao tác này" });
    }
    next();
  };
}

// =============================================
// CONFIG
// =============================================

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL?.includes("railway") ||
    process.env.DATABASE_URL?.includes("render")
      ? { rejectUnauthorized: false }
      : false,
});

// Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ storage: multer.memoryStorage() });

// =============================================
// DB HELPERS
// =============================================

const db = {
  async query(sql, params = []) {
    const client = await pool.connect();
    try {
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  },
  async all(sql, p = []) {
    return (await this.query(sql, p)).rows;
  },
  async get(sql, p = []) {
    return (await this.query(sql, p)).rows[0];
  },
  async run(sql, p = []) {
    return await this.query(sql, p);
  },
};

// =============================================
// WEBSOCKET – Print Bridge + POS Realtime (1 server, route by path)
// =============================================

const wss = new WebSocketServer({ server });
const bridgeClients = new Set();
const posClients    = new Set();

wss.on("connection", (ws, req) => {
  const rawUrl = req.url || "";
  const path   = rawUrl.split("?")[0];

  // ── /bridge — Print Bridge ──────────────────
  if (path === "/bridge") {
    const secret = rawUrl.match(/[?&]secret=([^&]+)/)?.[1];
    if (secret !== process.env.PRINT_BRIDGE_SECRET) {
      ws.close(1008, "Unauthorized"); return;
    }
    bridgeClients.add(ws);
    console.log(`✅ Print Bridge kết nối. Tổng: ${bridgeClients.size}`);
    ws.on("close", () => { bridgeClients.delete(ws); console.log(`⚠️  Print Bridge ngắt. Còn: ${bridgeClients.size}`); });
    ws.on("error", () => bridgeClients.delete(ws));
    return;
  }

  // ── /pos — POS Realtime Sync ─────────────────
  if (path === "/pos") {
    try {
      const tokenMatch = rawUrl.match(/[?&]token=([^&]+)/);
      const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : null;
      if (!token) { ws.close(1008, "Unauthorized"); return; }
      ws.posUser = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      console.error("POS WS auth error:", e.message);
      ws.close(1008, "Invalid token"); return;
    }
    posClients.add(ws);
    console.log(`✅ POS client: ${ws.posUser.username} (${ws.posUser.role}). Tổng: ${posClients.size}`);
    ws.on("close", () => { posClients.delete(ws); console.log(`⚠️  POS client ngắt. Còn: ${posClients.size}`); });
    ws.on("error", (e) => { console.error("POS WS error:", e.message); posClients.delete(ws); });
    return;
  }

  // Unknown path
  ws.close(1008, "Unknown path");
});

function broadcastToBridges(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of bridgeClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastToPos(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of posClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastToPos(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of posClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

async function createPrintJob(jobType, billId, payload) {
  const row = await db.get(
    "INSERT INTO print_jobs (bill_id, job_type, payload) VALUES ($1,$2,$3) RETURNING *",
    [billId || null, jobType, JSON.stringify(payload)],
  );
  broadcastToBridges({ event: "NEW_PRINT_JOB", job: row });
  return row;
}

// =============================================
// INIT DB
// =============================================

async function initDb() {
  await db.run(`CREATE TABLE IF NOT EXISTS menu (
    id SERIAL PRIMARY KEY, name TEXT, price INTEGER, type TEXT, image TEXT)`);
  await db.run(`CREATE TABLE IF NOT EXISTS bills (
    id SERIAL PRIMARY KEY, table_num INTEGER, total INTEGER,
    created_at TIMESTAMP DEFAULT NOW())`);
  await db.run(`CREATE TABLE IF NOT EXISTS bill_items (
    id SERIAL PRIMARY KEY, bill_id INTEGER REFERENCES bills(id),
    name TEXT, price INTEGER, qty INTEGER)`);
  await db.run(`CREATE TABLE IF NOT EXISTS tables (
    table_num INTEGER PRIMARY KEY, status TEXT DEFAULT 'PAID')`);
  // Thêm cột orders nếu chưa có (migration an toàn)
  await db.run(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS orders JSONB DEFAULT '{}'`);
  await db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT)`);
  await db.run(`CREATE TABLE IF NOT EXISTS print_printers (
    id SERIAL PRIMARY KEY,
    printer_name TEXT NOT NULL,
    job_type TEXT NOT NULL,
    paper_width INTEGER DEFAULT 80,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW())`);
  await db.run(`CREATE TABLE IF NOT EXISTS print_jobs (
    id SERIAL PRIMARY KEY,
    bill_id INTEGER,
    job_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW())`);

  const defaults = [
    ["store_name", "Tiệm Nướng Đà Lạt Và Em"],
    ["store_address", "24 đường 3 tháng 4, Đà Lạt"],
    ["store_phone", "081 366 5665"],
    ["total_tables", "20"],
  ];
  for (const [k, v] of defaults) {
    await db.run(
      "INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING",
      [k, v],
    );
  }
  await db.run(`CREATE TABLE IF NOT EXISTS users (
    id         SERIAL PRIMARY KEY,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'waiter',
    full_name  TEXT,
    active     BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
  )`);

  // Admin mac dinh
  const adminExists = await db.get(
    "SELECT id FROM users WHERE username='admin'",
  );
  if (!adminExists) {
    const hash = await bcrypt.hash("admin123", 10);
    await db.run(
      "INSERT INTO users (username,password,role,full_name) VALUES ($1,$2,'admin','Administrator')",
      ["admin", hash],
    );
    console.log("Tao tai khoan admin mac dinh: admin / admin123");
  }
  console.log("✅ DB initialized");
}

// =============================================
// AUTH APIs
// =============================================

app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: "Thiếu username/password" });
    const user = await db.get(
      "SELECT * FROM users WHERE username=$1 AND active=true",
      [username],
    );
    if (!user)
      return res
        .status(401)
        .json({ error: "Tài khoản không tồn tại hoặc đã bị khóa" });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Mật khẩu không đúng" });
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        full_name: user.full_name,
      },
      JWT_SECRET,
      { expiresIn: "12h" },
    );
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        full_name: user.full_name,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/auth/me", authMiddleware, (req, res) => {
  res.json(req.user);
});

// =============================================
// USER MANAGEMENT APIs (Admin only)
// =============================================

app.get("/users", authMiddleware, requireRole("admin"), async (req, res) => {
  try {
    res.json(
      await db.all(
        "SELECT id,username,role,full_name,active,created_at FROM users ORDER BY id",
      ),
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/users", authMiddleware, requireRole("admin"), async (req, res) => {
  try {
    const { username, password, role, full_name } = req.body;
    if (!username || !password || !role)
      return res.status(400).json({ error: "Thiếu thông tin" });
    if (!["admin", "cashier", "waiter"].includes(role))
      return res.status(400).json({ error: "Role không hợp lệ" });
    const hash = await bcrypt.hash(password, 10);
    await db.run(
      "INSERT INTO users (username,password,role,full_name) VALUES ($1,$2,$3,$4)",
      [username, hash, role, full_name || username],
    );
    res.json({ created: true });
  } catch (e) {
    if (e.code === "23505")
      return res.status(409).json({ error: "Username đã tồn tại" });
    res.status(500).json({ error: e.message });
  }
});

app.put(
  "/users/:id",
  authMiddleware,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { full_name, role, active, password } = req.body;
      const id = req.params.id;
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        await db.run(
          "UPDATE users SET full_name=$1,role=$2,active=$3,password=$4 WHERE id=$5",
          [full_name, role, active, hash, id],
        );
      } else {
        await db.run(
          "UPDATE users SET full_name=$1,role=$2,active=$3 WHERE id=$4",
          [full_name, role, active, id],
        );
      }
      res.json({ updated: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

app.delete(
  "/users/:id",
  authMiddleware,
  requireRole("admin"),
  async (req, res) => {
    try {
      if (req.user.id === Number(req.params.id))
        return res.status(400).json({ error: "Không thể xóa chính mình" });
      await db.run("DELETE FROM users WHERE id=$1", [req.params.id]);
      res.json({ deleted: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// =============================================
// MENU APIs
// =============================================

app.get("/menu", async (req, res) => {
  try {
    res.json(await db.all("SELECT * FROM menu ORDER BY id"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(
  "/menu",
  authMiddleware,
  requireRole("admin", "cashier"),
  upload.single("image"),
  async (req, res) => {
    try {
      const { name, price, type } = req.body;
      let imageUrl = "";
      if (req.file) {
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: "bbq-pos" },
            (err, r) => (err ? reject(err) : resolve(r)),
          );
          streamifier.createReadStream(req.file.buffer).pipe(stream);
        });
        imageUrl = result.secure_url;
      }
      await db.run(
        "INSERT INTO menu (name,price,type,image) VALUES ($1,$2,$3,$4)",
        [name, Number(price), type, imageUrl],
      );
      res.json({ added: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

app.put(
  "/menu/:id",
  authMiddleware,
  requireRole("admin", "cashier"),
  upload.single("image"),
  async (req, res) => {
    try {
      const { name, price, type } = req.body;
      const { id } = req.params;
      if (req.file) {
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: "bbq-pos" },
            (err, r) => (err ? reject(err) : resolve(r)),
          );
          streamifier.createReadStream(req.file.buffer).pipe(stream);
        });
        await db.run(
          "UPDATE menu SET name=$1,price=$2,type=$3,image=$4 WHERE id=$5",
          [name, Number(price), type, result.secure_url, id],
        );
      } else {
        await db.run("UPDATE menu SET name=$1,price=$2,type=$3 WHERE id=$4", [
          name,
          Number(price),
          type,
          id,
        ]);
      }
      res.json({ updated: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

app.delete(
  "/menu/:id",
  authMiddleware,
  requireRole("admin"),
  async (req, res) => {
    try {
      await db.run("DELETE FROM menu WHERE id=$1", [req.params.id]);
      res.json({ deleted: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// =============================================
// TABLE APIs
// =============================================

app.get("/tables", async (req, res) => {
  try {
    res.json(await db.all("SELECT * FROM tables"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lấy orders của 1 bàn
app.get("/tables/:num/orders", authMiddleware, async (req, res) => {
  try {
    const row = await db.get("SELECT orders FROM tables WHERE table_num=$1", [Number(req.params.num)]);
    res.json(row?.orders || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lưu orders của 1 bàn + broadcast realtime
app.post("/tables/:num/orders", authMiddleware, async (req, res) => {
  try {
    const num    = Number(req.params.num);
    const orders = req.body.orders || {};
    await db.run(
      "INSERT INTO tables (table_num, orders) VALUES ($1,$2) ON CONFLICT (table_num) DO UPDATE SET orders=$2",
      [num, JSON.stringify(orders)],
    );
    // Broadcast để các thiết bị khác cập nhật ngay
    broadcastToPos({ event: "ORDER_UPDATE", table_num: num, orders });
    res.json({ saved: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/tables/:num/status", async (req, res) => {
  try {
    const num = Number(req.params.num);
    const { status } = req.body;
    await db.run(
      "INSERT INTO tables (table_num,status) VALUES ($1,$2) ON CONFLICT (table_num) DO UPDATE SET status=$2",
      [num, status],
    );
    // Realtime: thông báo tất cả POS clients
    broadcastToPos({ event: "TABLE_STATUS", table_num: num, status });
    res.json({ updated: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/tables", async (req, res) => {
  try {
    const { table_num } = req.body;
    if (!table_num) return res.status(400).json({ error: "Thiếu số bàn" });
    const existing = await db.get("SELECT * FROM tables WHERE table_num=$1", [
      Number(table_num),
    ]);
    if (existing) return res.status(409).json({ error: "Bàn đã tồn tại" });
    await db.run("INSERT INTO tables (table_num,status) VALUES ($1,'PAID')", [
      Number(table_num),
    ]);
    res.json({ added: true, table_num: Number(table_num) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/tables/:num", async (req, res) => {
  try {
    const oldNum = Number(req.params.num);
    const { new_num } = req.body;
    if (!new_num) return res.status(400).json({ error: "Thiếu số bàn mới" });
    const existing = await db.get("SELECT * FROM tables WHERE table_num=$1", [
      Number(new_num),
    ]);
    if (existing)
      return res.status(409).json({ error: `Bàn ${new_num} đã tồn tại` });
    await db.run("UPDATE tables SET table_num=$1 WHERE table_num=$2", [
      Number(new_num),
      oldNum,
    ]);
    res.json({ updated: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/tables/:num", async (req, res) => {
  try {
    const num = Number(req.params.num);
    const busy = await db.get(
      "SELECT * FROM tables WHERE table_num=$1 AND status='OPEN'",
      [num],
    );
    if (busy) return res.status(400).json({ error: "Bàn đang có khách" });
    await db.run("DELETE FROM tables WHERE table_num=$1", [num]);
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// BILLS APIs
// =============================================

app.post(
  "/bills",
  authMiddleware,
  requireRole("admin", "cashier"),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { table_num, total, items } = req.body;
      await client.query("BEGIN");
      const r = await client.query(
        "INSERT INTO bills (table_num,total) VALUES ($1,$2) RETURNING id",
        [table_num, total],
      );
      const billId = r.rows[0].id;
      for (const item of items) {
        await client.query(
          "INSERT INTO bill_items (bill_id,name,price,qty) VALUES ($1,$2,$3,$4)",
          [billId, item.name, item.price, item.qty],
        );
      }
      await client.query(
        "INSERT INTO tables (table_num,status) VALUES ($1,'PAID') ON CONFLICT (table_num) DO UPDATE SET status='PAID'",
        [table_num],
      );
      await client.query("COMMIT");
      // Realtime: thông báo thanh toán xong → tất cả thiết bị biết bàn đã PAID
      broadcastToPos({ event: "BILL_PAID", table_num, bill_id: billId });
      res.json({ bill_id: billId });
    } catch (e) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  },
);

app.get("/bills", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    res.json(
      await db.all(
        `SELECT b.id, b.table_num, b.total, b.created_at,
              STRING_AGG(bi.name || ' x' || bi.qty, ', ' ORDER BY bi.id) AS items_summary
       FROM bills b LEFT JOIN bill_items bi ON bi.bill_id=b.id
       WHERE b.created_at::date=$1 GROUP BY b.id ORDER BY b.created_at DESC`,
        [date],
      ),
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/bills/:id", async (req, res) => {
  try {
    const bill = await db.get("SELECT * FROM bills WHERE id=$1", [
      req.params.id,
    ]);
    if (!bill) return res.status(404).json({ error: "Not found" });
    const items = await db.all("SELECT * FROM bill_items WHERE bill_id=$1", [
      req.params.id,
    ]);
    res.json({ ...bill, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// STATS APIs
// =============================================

app.get("/stats/today", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const summary = await db.get(
      `SELECT COUNT(*) AS bill_count, COALESCE(SUM(total),0) AS revenue FROM bills WHERE created_at::date=$1`,
      [today],
    );
    const topItems = await db.all(
      `SELECT bi.name, SUM(bi.qty) AS total_qty, SUM(bi.price*bi.qty) AS total_revenue FROM bill_items bi JOIN bills b ON b.id=bi.bill_id WHERE b.created_at::date=$1 GROUP BY bi.name ORDER BY total_qty DESC LIMIT 5`,
      [today],
    );
    res.json({ ...summary, top_items: topItems });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/stats/daily", async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    res.json(
      await db.all(
        `SELECT created_at::date AS date, COUNT(*) AS bill_count, SUM(total) AS revenue FROM bills WHERE TO_CHAR(created_at,'YYYY-MM')=$1 GROUP BY created_at::date ORDER BY date`,
        [month],
      ),
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/stats/monthly", async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const rows = await db.all(
      `SELECT created_at::date AS date, COUNT(*) AS bill_count, COALESCE(SUM(total),0) AS revenue FROM bills WHERE TO_CHAR(created_at,'YYYY-MM')=$1 GROUP BY created_at::date ORDER BY date`,
      [month],
    );
    const summary = await db.get(
      `SELECT COUNT(*) AS bill_count, COALESCE(SUM(total),0) AS revenue FROM bills WHERE TO_CHAR(created_at,'YYYY-MM')=$1`,
      [month],
    );
    const top = await db.all(
      `SELECT bi.name, SUM(bi.qty) AS total_qty, SUM(bi.price*bi.qty) AS total_revenue FROM bill_items bi JOIN bills b ON b.id=bi.bill_id WHERE TO_CHAR(b.created_at,'YYYY-MM')=$1 GROUP BY bi.name ORDER BY total_qty DESC LIMIT 5`,
      [month],
    );
    res.json({ ...summary, days: rows, top_items: top });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/stats/yearly", async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear().toString();
    const rows = await db.all(
      `SELECT TO_CHAR(created_at,'YYYY-MM') AS month, COUNT(*) AS bill_count, COALESCE(SUM(total),0) AS revenue FROM bills WHERE TO_CHAR(created_at,'YYYY')=$1 GROUP BY TO_CHAR(created_at,'YYYY-MM') ORDER BY month`,
      [year],
    );
    const summary = await db.get(
      `SELECT COUNT(*) AS bill_count, COALESCE(SUM(total),0) AS revenue FROM bills WHERE TO_CHAR(created_at,'YYYY')=$1`,
      [year],
    );
    const top = await db.all(
      `SELECT bi.name, SUM(bi.qty) AS total_qty, SUM(bi.price*bi.qty) AS total_revenue FROM bill_items bi JOIN bills b ON b.id=bi.bill_id WHERE TO_CHAR(b.created_at,'YYYY')=$1 GROUP BY bi.name ORDER BY total_qty DESC LIMIT 5`,
      [year],
    );
    res.json({ ...summary, months: rows, top_items: top });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// SETTINGS APIs
// =============================================

app.get("/settings", async (req, res) => {
  try {
    const rows = await db.all("SELECT key,value FROM settings");
    const obj = {};
    rows.forEach((r) => {
      obj[r.key] = r.value;
    });
    res.json(obj);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(
  "/settings",
  authMiddleware,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key) return res.status(400).json({ error: "Missing key" });
      await db.run(
        "INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",
        [key, value],
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// =============================================
// PRINT PRINTERS APIs
// =============================================

app.get("/print/printers", async (req, res) => {
  try {
    res.json(await db.all("SELECT * FROM print_printers ORDER BY id"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/print/printers", async (req, res) => {
  try {
    const { printer_name, job_type, paper_width } = req.body;
    if (!printer_name || !job_type)
      return res
        .status(400)
        .json({ error: "Thiếu printer_name hoặc job_type" });
    if (!["KITCHEN", "TAMTINH", "BILL", "ALL"].includes(job_type))
      return res.status(400).json({ error: "job_type không hợp lệ" });
    const row = await db.get(
      "INSERT INTO print_printers (printer_name,job_type,paper_width) VALUES ($1,$2,$3) RETURNING *",
      [printer_name, job_type, Number(paper_width) || 80],
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/print/printers/:id", async (req, res) => {
  try {
    const { printer_name, job_type, paper_width, is_active } = req.body;
    const row = await db.get(
      `UPDATE print_printers SET
        printer_name = COALESCE($1, printer_name),
        job_type     = COALESCE($2, job_type),
        paper_width  = COALESCE($3, paper_width),
        is_active    = COALESCE($4, is_active)
       WHERE id=$5 RETURNING *`,
      [
        printer_name || null,
        job_type || null,
        paper_width ? Number(paper_width) : null,
        is_active ?? null,
        req.params.id,
      ],
    );
    if (!row) return res.status(404).json({ error: "Không tìm thấy máy in" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/print/printers/:id", async (req, res) => {
  try {
    await db.run("DELETE FROM print_printers WHERE id=$1", [req.params.id]);
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// PRINT JOB APIs
// =============================================

app.get("/print/jobs", async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const limit = Number(req.query.limit) || 50;
    const rows = await db.all(
      `SELECT pj.*, b.table_num FROM print_jobs pj
       LEFT JOIN bills b ON b.id = pj.bill_id
       WHERE pj.status = $1 ORDER BY pj.created_at ASC LIMIT $2`,
      [status, limit],
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/print/jobs/:id/done", async (req, res) => {
  try {
    const row = await db.get(
      "UPDATE print_jobs SET status='done', updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING *",
      [req.params.id],
    );
    if (!row)
      return res.status(404).json({ error: "Job không tồn tại hoặc đã xử lý" });
    res.json({ success: true, job: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/print/jobs/:id/fail", async (req, res) => {
  try {
    const { error_message } = req.body;
    const row = await db.get(
      "UPDATE print_jobs SET status='failed', error_message=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
      [error_message || "Unknown error", req.params.id],
    );
    if (!row) return res.status(404).json({ error: "Job không tồn tại" });
    res.json({ success: true, job: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/print/jobs/:id/retry", async (req, res) => {
  try {
    const row = await db.get(
      "UPDATE print_jobs SET status='pending', error_message=NULL, updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: "Job không tồn tại" });
    broadcastToBridges({ event: "NEW_PRINT_JOB", job: row });
    res.json({ success: true, job: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// PRINT COMMAND APIs
// =============================================

app.post("/print/kitchen", async (req, res) => {
  try {
    const { bill_id, table_num, items, note } = req.body;
    if (!items || !items.length)
      return res.status(400).json({ error: "Thiếu items" });
    const job = await createPrintJob("KITCHEN", bill_id || null, {
      table_num,
      items,
      note,
    });
    res.json({ success: true, job_id: job.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/print/tamtinh", async (req, res) => {
  try {
    const { bill_id, table_num, items, total } = req.body;
    if (!table_num) return res.status(400).json({ error: "Thiếu table_num" });
    const job = await createPrintJob("TAMTINH", bill_id || null, {
      table_num,
      items,
      total,
    });
    res.json({ success: true, job_id: job.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/print/bill", async (req, res) => {
  try {
    const { bill_id, table_num, items, total } = req.body;
    if (!table_num) return res.status(400).json({ error: "Thiếu table_num" });
    const job = await createPrintJob("BILL", bill_id || null, {
      bill_id,
      table_num,
      items,
      total,
    });
    res.json({ success: true, job_id: job.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/print/bill/:id", async (req, res) => {
  try {
    const bill = await db.get("SELECT * FROM bills WHERE id=$1", [
      req.params.id,
    ]);
    if (!bill) return res.status(404).json({ error: "Không tìm thấy hóa đơn" });
    const items = await db.all("SELECT * FROM bill_items WHERE bill_id=$1", [
      req.params.id,
    ]);
    const job = await createPrintJob("BILL", bill.id, {
      ...bill,
      items,
      reprint: true,
    });
    res.json({ success: true, job_id: job.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/print/status", (req, res) => {
  res.json({
    connected: bridgeClients.size > 0,
    bridge_count: bridgeClients.size,
  });
});

// =============================================
// HEALTH
// =============================================

app.get("/health", (req, res) => res.json({ ok: true }));

// =============================================
// START
// =============================================

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ DB init failed:", err);
    process.exit(1);
  });