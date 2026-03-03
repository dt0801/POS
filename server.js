const express    = require("express");
const cors       = require("cors");
const multer     = require("multer");
const path       = require("path");
const fs         = require("fs");
const { Pool }   = require("pg");
const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");
require('dotenv').config();

// =============================================
// CONFIG
// =============================================

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// PostgreSQL pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") || process.env.DATABASE_URL?.includes("render")
    ? { rejectUnauthorized: false }
    : false,
});

// Cloudinary config (cho ảnh món ăn)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer – dùng memory storage (upload lên Cloudinary, không lưu disk)
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
  async all(sql, params = []) {
    const r = await this.query(sql, params);
    return r.rows;
  },
  async get(sql, params = []) {
    const r = await this.query(sql, params);
    return r.rows[0];
  },
  async run(sql, params = []) {
    return await this.query(sql, params);
  },
};

// =============================================
// INIT DB – tạo bảng nếu chưa có
// =============================================

async function initDb() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS menu (
      id    SERIAL PRIMARY KEY,
      name  TEXT,
      price INTEGER,
      type  TEXT,
      image TEXT
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS bills (
      id         SERIAL PRIMARY KEY,
      table_num  INTEGER,
      total      INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS bill_items (
      id       SERIAL PRIMARY KEY,
      bill_id  INTEGER REFERENCES bills(id),
      name     TEXT,
      price    INTEGER,
      qty      INTEGER
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS tables (
      table_num  INTEGER PRIMARY KEY,
      status     TEXT DEFAULT 'PAID'
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Print queue – dùng cho Print Bridge (máy in nhiệt LAN)
  await db.run(`
    CREATE TABLE IF NOT EXISTS print_queue (
      id         SERIAL PRIMARY KEY,
      job_type   TEXT,        -- 'kitchen' | 'tamtinh' | 'bill'
      payload    JSONB,
      status     TEXT DEFAULT 'pending',  -- 'pending' | 'done' | 'failed'
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Default settings
  const defaults = [
    ["store_name",    "Tiệm Nướng Đà Lạt Và Em"],
    ["store_address", "24 đường 3 tháng 4, Đà Lạt"],
    ["store_phone",   "081 366 5665"],
    ["total_tables",  "20"],
  ];
  for (const [k, v] of defaults) {
    await db.run(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
      [k, v]
    );
  }

  console.log("✅ DB initialized");
}

// =============================================
// CLOUDINARY UPLOAD HELPER
// =============================================

function uploadToCloudinary(buffer, folder = "bbq-pos") {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder },
      (err, result) => {
        if (err) reject(err);
        else resolve(result.secure_url);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// =============================================
// MENU APIs
// =============================================

app.get("/menu", async (req, res) => {
  try {
    const rows = await db.all("SELECT * FROM menu ORDER BY id ASC");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/menu", upload.single("image"), async (req, res) => {
  try {
    const { name, price, type } = req.body;
    let imageUrl = "";
    if (req.file) {
      imageUrl = await uploadToCloudinary(req.file.buffer);
    }
    await db.run(
      "INSERT INTO menu (name, price, type, image) VALUES ($1, $2, $3, $4)",
      [name, Number(price), type, imageUrl]
    );
    res.json({ added: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/menu/:id", upload.single("image"), async (req, res) => {
  try {
    const { name, price, type } = req.body;
    const { id } = req.params;
    if (req.file) {
      const imageUrl = await uploadToCloudinary(req.file.buffer);
      await db.run(
        "UPDATE menu SET name=$1, price=$2, type=$3, image=$4 WHERE id=$5",
        [name, Number(price), type, imageUrl, id]
      );
    } else {
      await db.run(
        "UPDATE menu SET name=$1, price=$2, type=$3 WHERE id=$4",
        [name, Number(price), type, id]
      );
    }
    res.json({ updated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/menu/:id", async (req, res) => {
  try {
    await db.run("DELETE FROM menu WHERE id=$1", [req.params.id]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================
// TABLE APIs
// =============================================

app.get("/tables", async (req, res) => {
  try {
    res.json(await db.all("SELECT * FROM tables"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/tables/:num/status", async (req, res) => {
  try {
    const { num } = req.params;
    const { status } = req.body;
    await db.run(
      "INSERT INTO tables (table_num, status) VALUES ($1, $2) ON CONFLICT (table_num) DO UPDATE SET status=$2",
      [Number(num), status]
    );
    res.json({ updated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/tables", async (req, res) => {
  try {
    const { table_num } = req.body;
    if (!table_num) return res.status(400).json({ error: "Thiếu số bàn" });
    const existing = await db.get("SELECT * FROM tables WHERE table_num=$1", [Number(table_num)]);
    if (existing) return res.status(409).json({ error: "Bàn đã tồn tại" });
    await db.run("INSERT INTO tables (table_num, status) VALUES ($1, 'PAID')", [Number(table_num)]);
    res.json({ added: true, table_num: Number(table_num) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/tables/:num", async (req, res) => {
  try {
    const oldNum = Number(req.params.num);
    const { new_num } = req.body;
    if (!new_num) return res.status(400).json({ error: "Thiếu số bàn mới" });
    const existing = await db.get("SELECT * FROM tables WHERE table_num=$1", [Number(new_num)]);
    if (existing) return res.status(409).json({ error: `Bàn ${new_num} đã tồn tại` });
    await db.run("UPDATE tables SET table_num=$1 WHERE table_num=$2", [Number(new_num), oldNum]);
    res.json({ updated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/tables/:num", async (req, res) => {
  try {
    const num = Number(req.params.num);
    const busy = await db.get("SELECT * FROM tables WHERE table_num=$1 AND status='OPEN'", [num]);
    if (busy) return res.status(400).json({ error: "Bàn đang có khách, không thể xóa" });
    await db.run("DELETE FROM tables WHERE table_num=$1", [num]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================
// BILLS APIs
// =============================================

app.post("/bills", async (req, res) => {
  const client = await pool.connect();
  try {
    const { table_num, total, items } = req.body;
    await client.query("BEGIN");

    const billRes = await client.query(
      "INSERT INTO bills (table_num, total) VALUES ($1, $2) RETURNING id",
      [table_num, total]
    );
    const billId = billRes.rows[0].id;

    for (const item of items) {
      await client.query(
        "INSERT INTO bill_items (bill_id, name, price, qty) VALUES ($1, $2, $3, $4)",
        [billId, item.name, item.price, item.qty]
      );
    }

    await client.query(
      "INSERT INTO tables (table_num, status) VALUES ($1, 'PAID') ON CONFLICT (table_num) DO UPDATE SET status='PAID'",
      [table_num]
    );

    await client.query("COMMIT");
    res.json({ bill_id: billId });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get("/bills", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const rows = await db.all(
      `SELECT b.id, b.table_num, b.total, b.created_at,
              STRING_AGG(bi.name || ' x' || bi.qty, ', ' ORDER BY bi.id) AS items_summary
       FROM bills b
       LEFT JOIN bill_items bi ON bi.bill_id = b.id
       WHERE b.created_at::date = $1
       GROUP BY b.id
       ORDER BY b.created_at DESC`,
      [date]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/bills/:id", async (req, res) => {
  try {
    const bill = await db.get("SELECT * FROM bills WHERE id=$1", [req.params.id]);
    if (!bill) return res.status(404).json({ error: "Not found" });
    const items = await db.all("SELECT * FROM bill_items WHERE bill_id=$1", [req.params.id]);
    res.json({ ...bill, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================
// STATS APIs
// =============================================

app.get("/stats/today", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const summary = await db.get(
      `SELECT COUNT(*) AS bill_count, COALESCE(SUM(total),0) AS revenue
       FROM bills WHERE created_at::date = $1`, [today]
    );
    const topItems = await db.all(
      `SELECT bi.name, SUM(bi.qty) AS total_qty, SUM(bi.price*bi.qty) AS total_revenue
       FROM bill_items bi JOIN bills b ON b.id=bi.bill_id
       WHERE b.created_at::date = $1
       GROUP BY bi.name ORDER BY total_qty DESC LIMIT 5`, [today]
    );
    res.json({ ...summary, top_items: topItems });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/stats/daily", async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const rows = await db.all(
      `SELECT created_at::date AS date, COUNT(*) AS bill_count, SUM(total) AS revenue
       FROM bills
       WHERE TO_CHAR(created_at, 'YYYY-MM') = $1
       GROUP BY created_at::date ORDER BY date ASC`, [month]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/stats/monthly", async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const rows = await db.all(
      `SELECT created_at::date AS date, COUNT(*) AS bill_count, COALESCE(SUM(total),0) AS revenue
       FROM bills WHERE TO_CHAR(created_at, 'YYYY-MM') = $1
       GROUP BY created_at::date ORDER BY date ASC`, [month]
    );
    const summary = await db.get(
      `SELECT COUNT(*) AS bill_count, COALESCE(SUM(total),0) AS revenue
       FROM bills WHERE TO_CHAR(created_at, 'YYYY-MM') = $1`, [month]
    );
    const topItems = await db.all(
      `SELECT bi.name, SUM(bi.qty) AS total_qty, SUM(bi.price*bi.qty) AS total_revenue
       FROM bill_items bi JOIN bills b ON b.id=bi.bill_id
       WHERE TO_CHAR(b.created_at, 'YYYY-MM') = $1
       GROUP BY bi.name ORDER BY total_qty DESC LIMIT 5`, [month]
    );
    res.json({ ...summary, days: rows, top_items: topItems });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/stats/yearly", async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear().toString();
    const rows = await db.all(
      `SELECT TO_CHAR(created_at, 'YYYY-MM') AS month, COUNT(*) AS bill_count, COALESCE(SUM(total),0) AS revenue
       FROM bills WHERE TO_CHAR(created_at, 'YYYY') = $1
       GROUP BY TO_CHAR(created_at, 'YYYY-MM') ORDER BY month ASC`, [year]
    );
    const summary = await db.get(
      `SELECT COUNT(*) AS bill_count, COALESCE(SUM(total),0) AS revenue
       FROM bills WHERE TO_CHAR(created_at, 'YYYY') = $1`, [year]
    );
    const topItems = await db.all(
      `SELECT bi.name, SUM(bi.qty) AS total_qty, SUM(bi.price*bi.qty) AS total_revenue
       FROM bill_items bi JOIN bills b ON b.id=bi.bill_id
       WHERE TO_CHAR(b.created_at, 'YYYY') = $1
       GROUP BY bi.name ORDER BY total_qty DESC LIMIT 5`, [year]
    );
    res.json({ ...summary, months: rows, top_items: topItems });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================
// SETTINGS APIs
// =============================================

app.get("/settings", async (req, res) => {
  try {
    const rows = await db.all("SELECT key, value FROM settings");
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/settings", async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: "Missing key" });
    await db.run(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2",
      [key, value]
    );
    res.json({ success: true, key, value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================
// PRINT QUEUE – Print Bridge system
// =============================================

// Cloud server nhận lệnh in → đẩy vào queue
// Print Bridge (chạy ở quầy) polling queue này để in

app.post("/print/kitchen", async (req, res) => {
  try {
    const { table_num, items } = req.body;
    await db.run(
      "INSERT INTO print_queue (job_type, payload, status) VALUES ('kitchen', $1, 'pending')",
      [JSON.stringify({ table_num, items })]
    );
    res.json({ success: true, queued: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/print/tamtinh", async (req, res) => {
  try {
    const { table_num, items, total } = req.body;
    await db.run(
      "INSERT INTO print_queue (job_type, payload, status) VALUES ('tamtinh', $1, 'pending')",
      [JSON.stringify({ table_num, items, total })]
    );
    res.json({ success: true, queued: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/print/bill", async (req, res) => {
  try {
    const { table_num, items, total } = req.body;
    await db.run(
      "INSERT INTO print_queue (job_type, payload, status) VALUES ('bill', $1, 'pending')",
      [JSON.stringify({ table_num, items, total })]
    );
    res.json({ success: true, queued: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/print/bill/:id", async (req, res) => {
  try {
    const bill = await db.get("SELECT * FROM bills WHERE id=$1", [req.params.id]);
    if (!bill) return res.status(404).json({ error: "Không tìm thấy hóa đơn" });
    const items = await db.all("SELECT * FROM bill_items WHERE bill_id=$1", [req.params.id]);
    await db.run(
      "INSERT INTO print_queue (job_type, payload, status) VALUES ('bill', $1, 'pending')",
      [JSON.stringify({ table_num: bill.table_num, items, total: bill.total, reprint: true, bill_id: bill.id })]
    );
    res.json({ success: true, queued: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Print Bridge polling endpoint – chỉ máy quầy gọi
app.get("/print/queue", async (req, res) => {
  try {
    const secret = req.headers["x-bridge-secret"];
    if (!secret || secret !== process.env.PRINT_BRIDGE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const jobs = await db.all(
      "SELECT * FROM print_queue WHERE status='pending' ORDER BY created_at ASC LIMIT 10"
    );
    res.json(jobs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Print Bridge đánh dấu job đã in xong
app.post("/print/queue/:id/done", async (req, res) => {
  try {
    const secret = req.headers["x-bridge-secret"];
    if (!secret || secret !== process.env.PRINT_BRIDGE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    await db.run("UPDATE print_queue SET status=$1 WHERE id=$2", [req.body.status || "done", req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Status máy in – kiểm tra Print Bridge có online không
app.get("/print/status", async (req, res) => {
  try {
    // Coi bridge online nếu có job done trong 5 phút gần nhất
    const recent = await db.get(
      `SELECT * FROM print_queue WHERE status='done'
       AND created_at > NOW() - INTERVAL '5 minutes'
       ORDER BY created_at DESC LIMIT 1`
    );
    res.json({ connected: !!recent, bridge_mode: true });
  } catch (e) { res.json({ connected: false }); }
});

// =============================================
// HEALTH CHECK
// =============================================

app.get("/health", (req, res) => res.json({ ok: true, time: new Date() }));

// =============================================
// START
// =============================================

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("❌ DB init failed:", err);
    process.exit(1);
  });
