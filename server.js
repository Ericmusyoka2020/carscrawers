
import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@libsql/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const ADMIN_SECRET = process.env.ADMIN_SECRET || "wariara_admin_2026";
const PAID_POST_LIFETIME_DAYS = 70;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

function serializeRows(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === "bigint" ? Number(v) : v;
    }
    return out;
  });
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  return safe;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, keyHex] = storedHash.split(":");
  const keyBuf = Buffer.from(keyHex, "hex");
  const derivedBuf = crypto.scryptSync(password, salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function computeRemainingDays(expiresAt) {
  if (!expiresAt) return null;
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(diffMs / (24 * 3600 * 1000)));
}

function enrichListing(row) {
  const isExpiredByTime = Boolean(row.expires_at && new Date(row.expires_at).getTime() <= Date.now());
  const effectiveStatus = isExpiredByTime && row.status !== "unsafe_removed" ? "expired" : row.status;
  return {
    ...row,
    status: effectiveStatus,
    days_remaining: row.expires_at ? computeRemainingDays(row.expires_at) : null,
  };
}

async function expireOverdueListings() {
  await db.execute({
    sql: `UPDATE listings
          SET status = 'expired', priority_amount_kes = 0, priority_expires_at = NULL
          WHERE expires_at IS NOT NULL
            AND expires_at <= CURRENT_TIMESTAMP
            AND status NOT IN ('expired', 'unsafe_removed')`,
    args: [],
  });
}

async function addSellerNotification(userId, message) {
  await db.execute({
    sql: `INSERT INTO seller_notifications (id, user_id, message) VALUES (?, ?, ?)`,
    args: [crypto.randomUUID(), userId, message],
  });
}

async function addAdminPaymentNotification({ payerId, payerName, payerEmail, payerPhone, amountKes, purpose, reference }) {
  await db.execute({
    sql: `INSERT INTO admin_payment_notifications (id, payer_id, payer_name, payer_email, payer_phone, amount_kes, purpose, payment_ref)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      payerId || null,
      payerName || "Unknown Payer",
      payerEmail || "",
      payerPhone || "",
      Number(amountKes || 0),
      purpose,
      reference || "PAYHERO",
    ],
  });
}

function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.admin_key;
  if (!key || key !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: "Invalid Admin Portal key." });
  }
  next();
}

async function ensureUsersAndListingsColumns() {
  const userInfo = await db.execute(`PRAGMA table_info(users)`);
  if (userInfo.rows.length > 0) {
    const existingCols = new Set(userInfo.rows.map((r) => String(r.name)));
    const columnsToAdd = [
      ["phone", "TEXT NOT NULL DEFAULT ''"],
      ["email", "TEXT"],
      ["password_hash", "TEXT"],
      ["whatsapp_phone", "TEXT NOT NULL DEFAULT ''"],
      ["call_phone", "TEXT NOT NULL DEFAULT ''"],
      ["role", "TEXT DEFAULT 'private'"],
      ["shop_slug", "TEXT"],
      ["town", "TEXT DEFAULT 'Nakuru'"],
      ["free_posts_used", "INTEGER DEFAULT 0"],
      ["paid_post_credits", "INTEGER DEFAULT 0"],
      ["is_suspended", "INTEGER DEFAULT 0"],
      ["suspension_reason", "TEXT"],
      ["appeal_text", "TEXT"],
      ["appeal_status", "TEXT DEFAULT 'none'"],
    ];
    for (const [colName, colDef] of columnsToAdd) {
      if (!existingCols.has(colName)) {
        await db.execute(`ALTER TABLE users ADD COLUMN ${colName} ${colDef}`);
      }
    }
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_shop_slug ON users(shop_slug) WHERE shop_slug IS NOT NULL`);
  }

  const listInfo = await db.execute(`PRAGMA table_info(listings)`);
  if (listInfo.rows.length > 0) {
    const existingListCols = new Set(listInfo.rows.map((r) => String(r.name)));
    if (!existingListCols.has("is_paid_post")) {
      await db.execute(`ALTER TABLE listings ADD COLUMN is_paid_post INTEGER DEFAULT 0`);
    }
    if (!existingListCols.has("expires_at")) {
      await db.execute(`ALTER TABLE listings ADD COLUMN expires_at DATETIME`);
    }
  }
}

let dbInitPromise = null;

async function initDatabase() {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      email TEXT UNIQUE,
      password_hash TEXT,
      whatsapp_phone TEXT NOT NULL DEFAULT '',
      call_phone TEXT NOT NULL DEFAULT '',
      role TEXT CHECK(role IN ('private', 'dealer')) DEFAULT 'private',
      shop_slug TEXT UNIQUE,
      town TEXT DEFAULT 'Nakuru',
      free_posts_used INTEGER DEFAULT 0,
      paid_post_credits INTEGER DEFAULT 0,
      is_suspended INTEGER DEFAULT 0,
      suspension_reason TEXT,
      appeal_text TEXT,
      appeal_status TEXT DEFAULT 'none',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS seller_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS admin_payment_notifications (
      id TEXT PRIMARY KEY,
      payer_id TEXT,
      payer_name TEXT NOT NULL,
      payer_email TEXT,
      payer_phone TEXT,
      amount_kes INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      payment_ref TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS post_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      post_count INTEGER NOT NULL,
      price_kes INTEGER NOT NULL,
      active INTEGER DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS post_purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_name TEXT NOT NULL,
      posts_added INTEGER NOT NULL,
      amount_kes INTEGER NOT NULL,
      payment_ref TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS vehicle_catalog (
      id TEXT PRIMARY KEY,
      vehicle_type TEXT NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      body_type TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      seller_id TEXT NOT NULL,
      category TEXT CHECK(category IN ('motor', 'part')) NOT NULL,
      title TEXT NOT NULL,
      price_kes INTEGER NOT NULL,
      negotiable TEXT CHECK(negotiable IN ('Yes', 'No')) DEFAULT 'Yes',
      town TEXT NOT NULL,
      description TEXT,
      vehicle_type TEXT,
      reg_number TEXT,
      condition_type TEXT,
      brand TEXT,
      model TEXT,
      body_type TEXT,
      year INTEGER,
      fuel_type TEXT,
      transmission TEXT,
      drive_type TEXT,
      air_con TEXT,
      engine_cc INTEGER,
      mileage_km INTEGER,
      part_name TEXT,
      part_make TEXT,
      part_model TEXT,
      year_from INTEGER,
      year_to INTEGER,
      part_condition TEXT,
      part_authenticity TEXT,
      is_paid_post INTEGER DEFAULT 0,
      expires_at DATETIME,
      status TEXT CHECK(status IN ('pending_approval', 'active', 'paused', 'reported_suspended', 'unsafe_removed', 'expired', 'sold')) DEFAULT 'pending_approval',
      report_reason TEXT,
      reported_at DATETIME,
      priority_amount_kes INTEGER DEFAULT 0,
      priority_expires_at DATETIME,
      views_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS listing_photos (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      photo_data TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, category, town, price_kes)`,
    `CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_id)`,
    `CREATE INDEX IF NOT EXISTS idx_resets_token ON password_resets(token_hash)`,
  ];

  for (const sql of ddl) {
    await db.execute(sql);
  }

  await ensureUsersAndListingsColumns();

  await db.execute({
    sql: `INSERT OR IGNORE INTO settings (key, value) VALUES ('base_priority_price_kes', '300')`,
    args: [],
  });
  await db.execute({
    sql: `INSERT OR IGNORE INTO settings (key, value) VALUES ('max_daily_priority_slots', '20')`,
    args: [],
  });

  const plansCnt = await db.execute(`SELECT COUNT(*) AS cnt FROM post_plans`);
  if (Number(plansCnt.rows[0].cnt) === 0) {
    await db.execute({
      sql: `INSERT INTO post_plans (id, name, post_count, price_kes) VALUES ('plan_starter', 'Starter', 10, 200)`,
      args: [],
    });
    await db.execute({
      sql: `INSERT INTO post_plans (id, name, post_count, price_kes) VALUES ('plan_pro', 'Pro 25', 25, 500)`,
      args: [],
    });
  }

  const catCnt = await db.execute(`SELECT COUNT(*) AS cnt FROM vehicle_catalog`);
  if (Number(catCnt.rows[0].cnt) === 0) {
    const seed = [
      ["Car", "Toyota", "Fielder", "Station Wagon"],
      ["Car", "Toyota", "Harrier", "SUV"],
      ["Car", "Toyota", "Premio", "Saloon"],
      ["Car", "Toyota", "Vitz", "Hatchback"],
      ["Car", "Toyota", "Land Cruiser Prado", "SUV"],
      ["Truck", "Toyota", "Hilux", "Pickup/Truck"],
      ["Car", "Audi", "A4", "Saloon"],
      ["Car", "Audi", "Q5", "SUV"],
      ["Car", "Mazda", "CX-5", "SUV"],
      ["Car", "Mazda", "Demio", "Hatchback"],
      ["Car", "Subaru", "Forester", "SUV"],
      ["Car", "Nissan", "X-Trail", "SUV"],
      ["Truck", "Isuzu", "D-Max", "Pickup/Truck"],
      ["Bike", "Boxer", "BM150", "Motorbike"],
    ];
    for (const [vt, br, mo, bo] of seed) {
      await db.execute({
        sql: `INSERT INTO vehicle_catalog (id, vehicle_type, brand, model, body_type) VALUES (?, ?, ?, ?, ?)`,
        args: [crypto.randomUUID(), vt, br, mo, bo],
      });
    }
  }

  const listCnt = await db.execute(`SELECT COUNT(*) AS cnt FROM listings`);
  if (Number(listCnt.rows[0].cnt) === 0) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO users (id, name, phone, email, password_hash, whatsapp_phone, call_phone, role, shop_slug, town, free_posts_used)
            VALUES ('usr_rift_dealer', 'Rift Valley Motors Nakuru', '0712345678', 'sales@riftmotors.co.ke', NULL, '254712345678', '0712345678', 'dealer', 'rift-valley-motors', 'Nakuru', 2)`,
      args: [],
    });
    await db.execute({
      sql: `INSERT INTO listings (
        id, seller_id, category, title, price_kes, negotiable, town, description,
        vehicle_type, reg_number, condition_type, brand, model, body_type, year,
        fuel_type, transmission, drive_type, air_con, engine_cc, mileage_km,
        is_paid_post, expires_at, status, priority_amount_kes, priority_expires_at
      ) VALUES (
        'car_sample_1', 'usr_rift_dealer', 'motor', '2018 Toyota Harrier Elegance', 3150000, 'Yes', 'Nakuru',
        'Clean direct import in Nakuru. Call or WhatsApp seller directly.',
        'Car', 'KDN 412B', 'Import', 'Toyota', 'Harrier', 'SUV', 2018,
        'Petrol', 'Automatic', 'Right', 'Yes', 2000, 68000,
        0, NULL, 'active', 450, ?
      )`,
      args: [new Date(Date.now() + 24 * 3600 * 1000).toISOString()],
    });
    await db.execute({
      sql: `INSERT INTO listing_photos (id, listing_id, photo_data, sort_order) VALUES (?, 'car_sample_1', ?, 0)`,
      args: [
        crypto.randomUUID(),
        "https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=900&q=75",
      ],
    });
  }
}

function ensureDbReady() {
  if (!dbInitPromise) {
    dbInitPromise = initDatabase().catch((err) => {
      dbInitPromise = null;
      throw err;
    });
  }
  return dbInitPromise;
}

app.use("/api", async (req, res, next) => {
  try {
    await ensureDbReady();
    await expireOverdueListings();
    next();
  } catch (err) {
    res.status(500).json({ ok: false, error: `Database initialization error: ${err.message}` });
  }
});

// ==========================================
// HEALTH & API ROOT
// ==========================================
app.get("/", (req, res) => {
  res.json({ ok: true, service: "wariara-cars-central-rift-api", mode: "api" });
});

app.get("/api/health", async (req, res) => {
  try {
    const ping = await db.execute("SELECT 1 AS ok");
    res.json({ ok: true, service: "wariara-cars-central-rift-api", db: serializeRows(ping.rows)[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// SELLER ACCOUNT, PASSWORD CONFIRMATION & ONE-TIME RESET TOKEN API
// ==========================================
app.post("/api/sellers/account", async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      confirm_password,
      whatsapp_phone,
      call_phone,
      role = "private",
      town = "Nakuru",
    } = req.body;

    if (!name || !email || !whatsapp_phone || !call_phone) {
      return res.status(400).json({
        error: "Name, email, WhatsApp number, and phone call number are required.",
      });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    if (password !== confirm_password) {
      return res.status(400).json({ error: "Passwords do not match. Enter the same password twice." });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanPhone = (call_phone || whatsapp_phone).trim();
    const existing = await db.execute({ sql: `SELECT * FROM users WHERE email = ?`, args: [cleanEmail] });

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: "An account with this email already exists. Sign in or use Forgot Password.",
      });
    }

    const id = crypto.randomUUID();
    const safeRole = role === "dealer" ? "dealer" : "private";
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") +
      "-" +
      id.slice(0, 4);
    const passwordHash = hashPassword(password);

    await db.execute({
      sql: `INSERT INTO users (id, name, phone, email, password_hash, whatsapp_phone, call_phone, role, shop_slug, town)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        name.trim(),
        cleanPhone,
        cleanEmail,
        passwordHash,
        whatsapp_phone.trim(),
        call_phone.trim(),
        safeRole,
        slug,
        town,
      ],
    });

    await addSellerNotification(id, "Account created. You have 6 free posts available (max 6 photos each).");
    const created = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [id] });
    res.status(201).json({ user: sanitizeUser(serializeRows(created.rows)[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sellers/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }
    const cleanEmail = email.trim().toLowerCase();
    const r = await db.execute({ sql: `SELECT * FROM users WHERE email = ?`, args: [cleanEmail] });
    if (r.rows.length === 0) return res.status(404).json({ error: "Seller account not found." });
    const user = serializeRows(r.rows)[0];
    if (!user.password_hash) {
      return res.status(400).json({
        error: "No password is set on this account yet. Use Forgot Password to set one.",
      });
    }
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Creates a single-use reset token for EmailJS to send to the seller's email
app.post("/api/sellers/forgot-password/token", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Enter your account email address." });
    const cleanEmail = email.trim().toLowerCase();
    const r = await db.execute({ sql: `SELECT * FROM users WHERE email = ?`, args: [cleanEmail] });
    if (r.rows.length === 0) return res.status(404).json({ error: "No seller account found with that email." });
    const user = serializeRows(r.rows)[0];

    await db.execute({
      sql: `UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL`,
      args: [user.id],
    });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    await db.execute({
      sql: `INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
      args: [crypto.randomUUID(), user.id, tokenHash, expiresAt],
    });

    res.json({
      token: rawToken,
      email: cleanEmail,
      name: user.name,
      expires_at: expiresAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Consumes token once so it can never be reused
app.post("/api/sellers/reset-password", async (req, res) => {
  try {
    const { token, password, confirm_password } = req.body;
    if (!token || !password || !confirm_password) {
      return res.status(400).json({ error: "Reset token, new password, and confirmation are required." });
    }
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
    if (password !== confirm_password) return res.status(400).json({ error: "Passwords do not match." });

    const tokenHash = hashToken(String(token).trim());
    const r = await db.execute({ sql: `SELECT * FROM password_resets WHERE token_hash = ?`, args: [tokenHash] });
    if (r.rows.length === 0) return res.status(400).json({ error: "Invalid password reset link." });

    const resetRow = serializeRows(r.rows)[0];
    if (resetRow.used_at) {
      return res.status(400).json({ error: "This reset link has already been used and cannot be used again." });
    }
    if (new Date(resetRow.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "This reset link has expired. Request a new one." });
    }

    const consumed = await db.execute({
      sql: `UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL`,
      args: [resetRow.id],
    });
    if (Number(consumed.rowsAffected || 0) === 0) {
      return res.status(400).json({ error: "This reset link has already been used." });
    }

    await db.execute({
      sql: `UPDATE users SET password_hash = ? WHERE id = ?`,
      args: [hashPassword(password), resetRow.user_id],
    });

    const updated = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [resetRow.user_id] });
    res.json({
      message: "Password updated! This reset link has now been used and cannot be reused.",
      user: sanitizeUser(serializeRows(updated.rows)[0]),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sellers/lookup", async (req, res) => {
  try {
    const { email, seller_id } = req.query;
    const result = seller_id
      ? await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [seller_id] })
      : await db.execute({ sql: `SELECT * FROM users WHERE email = ?`, args: [(email || "").trim().toLowerCase()] });
    if (result.rows.length === 0) return res.status(404).json({ error: "Seller account not found." });
    res.json({ user: sanitizeUser(serializeRows(result.rows)[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sellers/:id/notifications", async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT * FROM seller_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`,
      args: [req.params.id],
    });
    res.json({ notifications: serializeRows(r.rows) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sellers/:id/appeal", async (req, res) => {
  try {
    const { appeal_text } = req.body;
    if (!appeal_text || appeal_text.trim().length < 4) {
      return res.status(400).json({ error: "Enter a review request message." });
    }
    await db.execute({
      sql: `UPDATE users SET appeal_text = ?, appeal_status = 'pending' WHERE id = ?`,
      args: [appeal_text.trim(), req.params.id],
    });
    res.json({ message: "Suspension review request sent to Admin." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sellers/:id/listings", async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT l.*,
              (SELECT photo_data FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.sort_order ASC LIMIT 1) AS cover_photo,
              (SELECT COUNT(*) FROM listing_photos p WHERE p.listing_id = l.id) AS photo_count
            FROM listings l WHERE l.seller_id = ? ORDER BY l.created_at DESC`,
      args: [req.params.id],
    });
    res.json({ listings: serializeRows(result.rows).map(enrichListing) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PUBLIC MARKETPLACE & PRIORITY API (ONLY ADMIN-APPROVED ACTIVE POSTS)
// ==========================================
app.get("/api/meta", async (req, res) => {
  try {
    const catalog = await db.execute(`SELECT * FROM vehicle_catalog ORDER BY brand ASC, model ASC`);
    const plans = await db.execute(`SELECT * FROM post_plans WHERE active = 1 ORDER BY price_kes ASC`);
    const settingsRows = await db.execute(`SELECT * FROM settings`);
    const settings = {};
    for (const r of settingsRows.rows) settings[r.key] = r.value;
    res.json({
      catalog: serializeRows(catalog.rows),
      plans: serializeRows(plans.rows),
      settings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/priority/leaderboard", async (req, res) => {
  try {
    const settingsRows = await db.execute(`SELECT * FROM settings`);
    const settings = {};
    for (const r of settingsRows.rows) settings[r.key] = Number(r.value);

    const maxSlots = settings.max_daily_priority_slots || 20;
    const baseFee = settings.base_priority_price_kes || 300;

    const slotsRes = await db.execute({
      sql: `SELECT l.id, l.title, l.category, l.priority_amount_kes, l.priority_expires_at, u.name AS seller_name
            FROM listings l
            JOIN users u ON u.id = l.seller_id
            WHERE l.status = 'active' AND u.is_suspended = 0
              AND (l.expires_at IS NULL OR l.expires_at > CURRENT_TIMESTAMP)
              AND l.priority_amount_kes > 0 AND l.priority_expires_at > CURRENT_TIMESTAMP
            ORDER BY l.priority_amount_kes DESC, l.created_at DESC
            LIMIT ?`,
      args: [maxSlots],
    });

    const slots = serializeRows(slotsRes.rows);
    const highestBid = slots.length > 0 ? slots[0].priority_amount_kes : 0;
    const lowestSlot = slots.length >= maxSlots ? slots[slots.length - 1].priority_amount_kes : 0;
    const minToEnter = slots.length >= maxSlots ? Math.max(baseFee, lowestSlot + 50) : baseFee;

    res.json({
      baseFee,
      maxSlots,
      usedSlots: slots.length,
      highestBid,
      minToEnter,
      recommendedForTop1: Math.max(baseFee, highestBid + 50),
      leaderboard: slots,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/listings", async (req, res) => {
  try {
    const {
      category = "motor",
      q,
      vehicle_type,
      brand,
      model,
      body_type,
      town,
      condition_type,
      fuel_type,
      transmission,
      drive_type,
      air_con,
      part_authenticity,
      min_price,
      max_price,
      min_year,
      max_year,
      seller_slug,
      sort = "featured",
    } = req.query;

    const where = [
      "l.status = 'active'",
      "u.is_suspended = 0",
      "(l.expires_at IS NULL OR l.expires_at > CURRENT_TIMESTAMP)",
    ];
    const args = [];

    if (category && category !== "all") {
      where.push("l.category = ?");
      args.push(category);
    }
    if (seller_slug) {
      where.push("u.shop_slug = ?");
      args.push(seller_slug);
    }
    if (q) {
      where.push(
        "(LOWER(l.title) LIKE ? OR LOWER(l.description) LIKE ? OR LOWER(COALESCE(l.brand,'')) LIKE ? OR LOWER(COALESCE(l.part_name,'')) LIKE ?)"
      );
      const t = `%${q.toLowerCase()}%`;
      args.push(t, t, t, t);
    }
    if (vehicle_type) {
      where.push("l.vehicle_type = ?");
      args.push(vehicle_type);
    }
    if (brand) {
      where.push("(LOWER(l.brand) = LOWER(?) OR LOWER(l.part_make) = LOWER(?))");
      args.push(brand, brand);
    }
    if (model) {
      where.push("(LOWER(l.model) = LOWER(?) OR LOWER(l.part_model) = LOWER(?))");
      args.push(model, model);
    }
    if (body_type) {
      where.push("l.body_type = ?");
      args.push(body_type);
    }
    if (town) {
      where.push("LOWER(l.town) = LOWER(?)");
      args.push(town);
    }
    if (condition_type) {
      where.push("(l.condition_type = ? OR l.part_condition = ?)");
      args.push(condition_type, condition_type);
    }
    if (fuel_type) {
      where.push("l.fuel_type = ?");
      args.push(fuel_type);
    }
    if (transmission) {
      where.push("l.transmission = ?");
      args.push(transmission);
    }
    if (drive_type) {
      where.push("l.drive_type = ?");
      args.push(drive_type);
    }
    if (air_con) {
      where.push("l.air_con = ?");
      args.push(air_con);
    }
    if (part_authenticity) {
      where.push("l.part_authenticity = ?");
      args.push(part_authenticity);
    }
    if (min_price) {
      where.push("l.price_kes >= ?");
      args.push(Number(min_price));
    }
    if (max_price) {
      where.push("l.price_kes <= ?");
      args.push(Number(max_price));
    }
    if (min_year) {
      where.push("(l.year >= ? OR l.year_to >= ?)");
      args.push(Number(min_year), Number(min_year));
    }
    if (max_year) {
      where.push("(l.year <= ? OR l.year_from <= ?)");
      args.push(Number(max_year), Number(max_year));
    }

    let orderBy = `is_sponsored DESC, effective_priority DESC, seller_slot ASC, l.created_at DESC`;
    if (sort === "newest") orderBy = `is_sponsored DESC, effective_priority DESC, l.created_at DESC`;
    if (sort === "price_asc") orderBy = `l.price_kes ASC`;
    if (sort === "price_desc") orderBy = `l.price_kes DESC`;
    if (sort === "mileage_asc") orderBy = `COALESCE(l.mileage_km, 99999999) ASC`;
    if (sort === "year_desc") orderBy = `COALESCE(l.year, l.year_to, 0) DESC`;

    const sql = `
      WITH ranked AS (
        SELECT l.*, u.name AS seller_name, u.role AS seller_role, u.shop_slug AS seller_slug,
               u.whatsapp_phone, u.call_phone,
               (SELECT photo_data FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.sort_order ASC LIMIT 1) AS cover_photo,
               (SELECT COUNT(*) FROM listing_photos p WHERE p.listing_id = l.id) AS photo_count,
               CASE WHEN l.priority_amount_kes > 0 AND l.priority_expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS is_sponsored,
               CASE WHEN l.priority_amount_kes > 0 AND l.priority_expires_at > CURRENT_TIMESTAMP THEN l.priority_amount_kes ELSE 0 END AS effective_priority,
               ROW_NUMBER() OVER (PARTITION BY l.seller_id ORDER BY l.created_at DESC) AS seller_slot
        FROM listings l
        JOIN users u ON u.id = l.seller_id
        WHERE ${where.join(" AND ")}
      )
      SELECT * FROM ranked l ORDER BY ${orderBy} LIMIT 100
    `;
    const rows = await db.execute({ sql, args });
    res.json({ listings: serializeRows(rows.rows).map(enrichListing) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/listings/:id", async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT l.*, u.name AS seller_name, u.role AS seller_role, u.shop_slug AS seller_slug,
                   u.whatsapp_phone, u.call_phone, u.town AS seller_town
            FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?`,
      args: [req.params.id],
    });
    if (r.rows.length === 0) return res.status(404).json({ error: "Not found" });
    const listing = enrichListing(serializeRows(r.rows)[0]);
    const photos = await db.execute({
      sql: `SELECT id, photo_data, sort_order FROM listing_photos WHERE listing_id = ? ORDER BY sort_order ASC`,
      args: [req.params.id],
    });
    listing.photos = serializeRows(photos.rows);
    res.json({ listing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/dealers", async (req, res) => {
  try {
    const r = await db.execute(`
      SELECT u.id, u.name, u.shop_slug, u.town, u.whatsapp_phone, u.call_phone, COUNT(l.id) AS active_listings
      FROM users u
      LEFT JOIN listings l ON l.seller_id = u.id AND l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at > CURRENT_TIMESTAMP)
      WHERE u.is_suspended = 0
      GROUP BY u.id HAVING active_listings > 0 ORDER BY active_listings DESC
    `);
    res.json({ dealers: serializeRows(r.rows) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/listings/:id/report", async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || reason.trim().length < 3) return res.status(400).json({ error: "Provide a report reason." });
    await db.execute({
      sql: `UPDATE listings SET status = 'reported_suspended', report_reason = ?, reported_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'`,
      args: [reason.trim(), req.params.id],
    });
    res.json({ message: "Post reported and automatically suspended pending Admin safety review." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// SELLER POSTING, PAID PLANS (70-DAY POSTS), PAUSE, EDIT & PRIORITY API
// ==========================================
app.post("/api/plans/purchase", async (req, res) => {
  try {
    const { seller_id, plan_id, payment_ref, payer_phone } = req.body;
    const uRes = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [seller_id] });
    if (uRes.rows.length === 0) return res.status(404).json({ error: "Seller not found" });
    const seller = serializeRows(uRes.rows)[0];

    const pRes = await db.execute({ sql: `SELECT * FROM post_plans WHERE id = ? AND active = 1`, args: [plan_id] });
    if (pRes.rows.length === 0) return res.status(404).json({ error: "Plan not found" });
    const plan = serializeRows(pRes.rows)[0];

    await db.execute({
      sql: `UPDATE users SET paid_post_credits = paid_post_credits + ? WHERE id = ?`,
      args: [plan.post_count, seller_id],
    });
    await db.execute({
      sql: `INSERT INTO post_purchases (id, user_id, plan_name, posts_added, amount_kes, payment_ref) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        seller_id,
        plan.name,
        plan.post_count,
        plan.price_kes,
        payment_ref || "PAYHERO",
      ],
    });

    await addSellerNotification(
      seller_id,
      `Payment confirmed (KES ${plan.price_kes}): Added ${plan.post_count} post credits (${plan.name} plan). Posts created with paid credits run for ${PAID_POST_LIFETIME_DAYS} days.`
    );

    await addAdminPaymentNotification({
      payerId: seller.id,
      payerName: seller.name,
      payerEmail: seller.email,
      payerPhone: payer_phone || seller.whatsapp_phone || seller.call_phone,
      amountKes: plan.price_kes,
      purpose: `Post Plan Purchase: ${plan.name} (${plan.post_count} posts, 70-day duration)`,
      reference: payment_ref || "PAYHERO",
    });

    const updatedUser = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [seller_id] });
    res.json({
      message: `Payment confirmed! Added ${plan.post_count} post credits (${plan.name}).`,
      user: sanitizeUser(serializeRows(updatedUser.rows)[0]),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/listings", async (req, res) => {
  try {
    const b = req.body;
    if (!b.seller_id) return res.status(400).json({ error: "Seller account is required to post." });

    const uRes = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [b.seller_id] });
    if (uRes.rows.length === 0) return res.status(404).json({ error: "Seller account not found." });
    const seller = serializeRows(uRes.rows)[0];

    if (seller.is_suspended) {
      return res.status(403).json({ error: "Account suspended. Submit a review request first." });
    }

    const freeLeft = Math.max(0, 6 - seller.free_posts_used);
    if (freeLeft === 0 && seller.paid_post_credits <= 0) {
      return res.status(402).json({
        error: "You have used all 6 free posts. Purchase a post package to post more.",
        needs_plan: true,
      });
    }

    const category = b.category === "part" ? "part" : "motor";
    const priceNum = Number(b.price_kes);
    const town = String(b.town || "").trim();
    const description = String(b.description || "").trim();

    if (!priceNum || priceNum <= 0 || !town || !description) {
      return res.status(400).json({ error: "Price, location, and description are required." });
    }

    if (category === "motor") {
      const requiredMotor = [
        b.vehicle_type,
        b.condition_type,
        b.brand,
        b.model,
        b.body_type,
        b.year,
        b.reg_number,
        b.fuel_type,
        b.transmission,
        b.drive_type,
        b.air_con,
        b.engine_cc,
        b.mileage_km,
      ];
      if (requiredMotor.some((v) => v === undefined || v === null || String(v).trim() === "")) {
        return res.status(400).json({ error: "Please fill in all motor fields before submitting." });
      }
    } else {
      const requiredPart = [
        b.part_name,
        b.part_make,
        b.part_model,
        b.year_from,
        b.year_to,
        b.part_condition,
        b.part_authenticity,
      ];
      if (requiredPart.some((v) => v === undefined || v === null || String(v).trim() === "")) {
        return res.status(400).json({ error: "Please fill in all spare part fields before submitting." });
      }
    }

    const photos = Array.isArray(b.photos) ? b.photos : [];
    if (photos.length === 0) return res.status(400).json({ error: "At least 1 photo is required." });
    if (photos.length > 6) return res.status(400).json({ error: "Maximum 6 photos allowed per post." });

    const useFreePost = freeLeft > 0;
    const expiresAt = useFreePost
      ? null
      : new Date(Date.now() + PAID_POST_LIFETIME_DAYS * 24 * 3600 * 1000).toISOString();

    const id = crypto.randomUUID();
    const title =
      category === "motor"
        ? `${b.year} ${b.brand} ${b.model}`.trim()
        : `${b.part_name} (${b.part_make} ${b.part_model})`.trim();

    await db.execute({
      sql: `INSERT INTO listings (
        id, seller_id, category, title, price_kes, negotiable, town, description,
        vehicle_type, reg_number, condition_type, brand, model, body_type, year,
        fuel_type, transmission, drive_type, air_con, engine_cc, mileage_km,
        part_name, part_make, part_model, year_from, year_to, part_condition, part_authenticity,
        is_paid_post, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval')`,
      args: [
        id,
        seller.id,
        category,
        title,
        priceNum,
        b.negotiable === "No" ? "No" : "Yes",
        town,
        description,
        category === "motor" ? String(b.vehicle_type).trim() : null,
        category === "motor" ? String(b.reg_number).trim() : null,
        category === "motor" ? String(b.condition_type).trim() : null,
        category === "motor" ? String(b.brand).trim() : null,
        category === "motor" ? String(b.model).trim() : null,
        category === "motor" ? String(b.body_type).trim() : null,
        category === "motor" ? Number(b.year) : null,
        category === "motor" ? String(b.fuel_type).trim() : null,
        category === "motor" ? String(b.transmission).trim() : null,
        category === "motor" ? String(b.drive_type).trim() : null,
        category === "motor" ? String(b.air_con).trim() : null,
        category === "motor" ? Number(b.engine_cc) : null,
        category === "motor" ? Number(b.mileage_km) : null,
        category === "part" ? String(b.part_name).trim() : null,
        category === "part" ? String(b.part_make).trim() : null,
        category === "part" ? String(b.part_model).trim() : null,
        category === "part" ? Number(b.year_from) : null,
        category === "part" ? Number(b.year_to) : null,
        category === "part" ? String(b.part_condition).trim() : null,
        category === "part" ? String(b.part_authenticity).trim() : null,
        useFreePost ? 0 : 1,
        expiresAt,
      ],
    });

    for (let i = 0; i < photos.length; i++) {
      await db.execute({
        sql: `INSERT INTO listing_photos (id, listing_id, photo_data, sort_order) VALUES (?, ?, ?, ?)`,
        args: [crypto.randomUUID(), id, photos[i], i],
      });
    }

    if (useFreePost) {
      const nextFreeUsed = Number(seller.free_posts_used) + 1;
      await db.execute({
        sql: `UPDATE users SET free_posts_used = ? WHERE id = ?`,
        args: [nextFreeUsed, seller.id],
      });
      await addSellerNotification(
        seller.id,
        `Post submitted ("${title}"): 1 Free post deducted (${nextFreeUsed}/6 used; ${Math.max(0, 6 - nextFreeUsed)} free left). Awaiting Admin approval.`
      );
    } else {
      const nextPaidCredits = Math.max(0, Number(seller.paid_post_credits) - 1);
      await db.execute({
        sql: `UPDATE users SET paid_post_credits = ? WHERE id = ?`,
        args: [nextPaidCredits, seller.id],
      });
      await addSellerNotification(
        seller.id,
        `Post submitted ("${title}"): 1 Paid post credit deducted (${nextPaidCredits} paid credits left). Runs for ${PAID_POST_LIFETIME_DAYS} days after approval.`
      );
    }

    res.status(201).json({
      id,
      message: useFreePost
        ? "Post submitted! 1 free post credit deducted. Awaiting Admin approval."
        : `Post submitted! 1 paid post credit deducted (70-day duration). Awaiting Admin approval.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/listings/:id", async (req, res) => {
  try {
    const r = await db.execute({ sql: `SELECT * FROM listings WHERE id = ?`, args: [req.params.id] });
    if (r.rows.length === 0) return res.status(404).json({ error: "Listing not found" });
    const existing = serializeRows(r.rows)[0];
    const b = req.body;

    if (b.seller_id && b.seller_id !== existing.seller_id) {
      return res.status(403).json({ error: "Only the post owner can edit this listing." });
    }

    const title =
      existing.category === "motor"
        ? `${b.year ?? existing.year} ${b.brand ?? existing.brand} ${b.model ?? existing.model}`.trim()
        : `${b.part_name ?? existing.part_name} (${b.part_make ?? existing.part_make} ${b.part_model ?? existing.part_model})`.trim();

    await db.execute({
      sql: `UPDATE listings SET
        title = ?, price_kes = ?, negotiable = ?, town = ?, description = ?,
        vehicle_type = ?, reg_number = ?, condition_type = ?, brand = ?, model = ?, body_type = ?,
        year = ?, fuel_type = ?, transmission = ?, drive_type = ?, air_con = ?, engine_cc = ?, mileage_km = ?,
        part_name = ?, part_make = ?, part_model = ?, year_from = ?, year_to = ?, part_condition = ?, part_authenticity = ?
        WHERE id = ?`,
      args: [
        title,
        Number(b.price_kes ?? existing.price_kes),
        b.negotiable ?? existing.negotiable,
        b.town ?? existing.town,
        b.description ?? existing.description,
        b.vehicle_type ?? existing.vehicle_type,
        b.reg_number ?? existing.reg_number,
        b.condition_type ?? existing.condition_type,
        b.brand ?? existing.brand,
        b.model ?? existing.model,
        b.body_type ?? existing.body_type,
        b.year ? Number(b.year) : existing.year,
        b.fuel_type ?? existing.fuel_type,
        b.transmission ?? existing.transmission,
        b.drive_type ?? existing.drive_type,
        b.air_con ?? existing.air_con,
        b.engine_cc ? Number(b.engine_cc) : existing.engine_cc,
        b.mileage_km ? Number(b.mileage_km) : existing.mileage_km,
        b.part_name ?? existing.part_name,
        b.part_make ?? existing.part_make,
        b.part_model ?? existing.part_model,
        b.year_from ? Number(b.year_from) : existing.year_from,
        b.year_to ? Number(b.year_to) : existing.year_to,
        b.part_condition ?? existing.part_condition,
        b.part_authenticity ?? existing.part_authenticity,
        req.params.id,
      ],
    });

    if (Array.isArray(b.photos) && b.photos.length > 0) {
      if (b.photos.length > 6) return res.status(400).json({ error: "Maximum 6 photos allowed." });
      await db.execute({ sql: `DELETE FROM listing_photos WHERE listing_id = ?`, args: [req.params.id] });
      for (let i = 0; i < b.photos.length; i++) {
        await db.execute({
          sql: `INSERT INTO listing_photos (id, listing_id, photo_data, sort_order) VALUES (?, ?, ?, ?)`,
          args: [crypto.randomUUID(), req.params.id, b.photos[i], i],
        });
      }
    }

    res.json({ message: "Listing updated." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/listings/:id/status", async (req, res) => {
  try {
    const { status, seller_id } = req.body;
    if (!["active", "paused", "sold"].includes(status)) return res.status(400).json({ error: "Invalid status" });

    const r = await db.execute({ sql: `SELECT * FROM listings WHERE id = ?`, args: [req.params.id] });
    if (r.rows.length === 0) return res.status(404).json({ error: "Listing not found" });
    const existing = enrichListing(serializeRows(r.rows)[0]);

    if (seller_id && seller_id !== existing.seller_id) return res.status(403).json({ error: "Unauthorized" });
    if (existing.status === "expired") {
      return res.status(403).json({ error: "This post has expired after 70 days." });
    }
    if (["pending_approval", "reported_suspended", "unsafe_removed"].includes(existing.status)) {
      return res.status(403).json({ error: "Listing is currently under Admin approval or safety review." });
    }

    await db.execute({ sql: `UPDATE listings SET status = ? WHERE id = ?`, args: [status, req.params.id] });
    res.json({ message: `Post marked as ${status}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/listings/:id/prioritize", async (req, res) => {
  try {
    const bid = Number(req.body.amount_kes);
    const paymentRef = req.body.payment_ref || "PAYHERO";
    const payerPhone = req.body.payer_phone || "";

    const lRes = await db.execute({
      sql: `SELECT l.*, u.name AS seller_name, u.email AS seller_email, u.whatsapp_phone, u.call_phone
            FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?`,
      args: [req.params.id],
    });
    if (lRes.rows.length === 0) return res.status(404).json({ error: "Listing not found." });
    const targetListing = enrichListing(serializeRows(lRes.rows)[0]);
    if (targetListing.status !== "active") {
      return res.status(400).json({ error: "Only active approved posts can be prioritized." });
    }

    const sRows = await db.execute(`SELECT * FROM settings`);
    const settings = {};
    for (const r of sRows.rows) settings[r.key] = Number(r.value);

    const baseFee = settings.base_priority_price_kes || 300;
    const maxSlots = settings.max_daily_priority_slots || 20;

    if (!bid || bid < baseFee) return res.status(400).json({ error: `Minimum priority fee is KES ${baseFee}.` });

    const slotsRes = await db.execute({
      sql: `SELECT id, priority_amount_kes FROM listings
            WHERE status = 'active' AND priority_amount_kes > 0 AND priority_expires_at > CURRENT_TIMESTAMP AND id != ?
            ORDER BY priority_amount_kes DESC`,
      args: [req.params.id],
    });
    const slots = serializeRows(slotsRes.rows);

    if (slots.length >= maxSlots) {
      const lowest = slots[maxSlots - 1];
      if (bid <= lowest.priority_amount_kes) {
        return res.status(400).json({
          error: `Top ${maxSlots} slots are full. Bid higher than KES ${lowest.priority_amount_kes}.`,
        });
      }
      await db.execute({
        sql: `UPDATE listings SET priority_amount_kes = 0, priority_expires_at = NULL WHERE id = ?`,
        args: [lowest.id],
      });
    }

    await db.execute({
      sql: `UPDATE listings SET priority_amount_kes = ?, priority_expires_at = ? WHERE id = ?`,
      args: [bid, new Date(Date.now() + 24 * 3600 * 1000).toISOString(), req.params.id],
    });

    await addSellerNotification(
      targetListing.seller_id,
      `Payment confirmed (KES ${bid}): Post "${targetListing.title}" prioritized for 24 hours.`
    );

    await addAdminPaymentNotification({
      payerId: targetListing.seller_id,
      payerName: targetListing.seller_name,
      payerEmail: targetListing.seller_email,
      payerPhone: payerPhone || targetListing.whatsapp_phone || targetListing.call_phone,
      amountKes: bid,
      purpose: `Prioritise Post (24h): ${targetListing.title}`,
      reference: paymentRef,
    });

    res.json({ message: `Payment confirmed! Prioritized at KES ${bid} for 24h.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// DEDICATED ADMIN PORTAL API
// ==========================================
app.get("/api/admin/overview", requireAdminKey, async (req, res) => {
  try {
    const listingsRes = await db.execute(`
      SELECT l.*, u.name AS seller_name, u.email AS seller_email, u.whatsapp_phone, u.call_phone,
             (SELECT photo_data FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.sort_order ASC LIMIT 1) AS cover_photo
      FROM listings l JOIN users u ON u.id = l.seller_id
      ORDER BY CASE l.status WHEN 'reported_suspended' THEN 1 WHEN 'pending_approval' THEN 2 WHEN 'active' THEN 3 WHEN 'expired' THEN 4 ELSE 5 END, l.created_at DESC
    `);
    const users = await db.execute(`
      SELECT u.*,
             (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id) AS total_posts,
             (SELECT COALESCE(SUM(posts_added), 0) FROM post_purchases pp WHERE pp.user_id = u.id) AS total_purchased_posts,
             (SELECT COALESCE(SUM(amount_kes), 0) FROM post_purchases pp WHERE pp.user_id = u.id) AS total_spent_kes
      FROM users u ORDER BY u.created_at DESC
    `);
    const paymentNotifications = await db.execute(`
      SELECT * FROM admin_payment_notifications ORDER BY created_at DESC LIMIT 100
    `);
    const plans = await db.execute(`SELECT * FROM post_plans ORDER BY price_kes ASC`);
    const catalog = await db.execute(`SELECT * FROM vehicle_catalog ORDER BY brand ASC, model ASC`);
    const sRows = await db.execute(`SELECT * FROM settings`);
    const settings = {};
    for (const r of sRows.rows) settings[r.key] = r.value;

    res.json({
      listings: serializeRows(listingsRes.rows).map(enrichListing),
      users: serializeRows(users.rows).map(sanitizeUser),
      paymentNotifications: serializeRows(paymentNotifications.rows),
      plans: serializeRows(plans.rows),
      catalog: serializeRows(catalog.rows),
      settings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/listings/:id/moderate", requireAdminKey, async (req, res) => {
  try {
    const { action } = req.body;
    const r = await db.execute({ sql: `SELECT * FROM listings WHERE id = ?`, args: [req.params.id] });
    if (r.rows.length === 0) return res.status(404).json({ error: "Listing not found." });
    const existing = serializeRows(r.rows)[0];

    let status;
    let nextExpiresAt = existing.expires_at;
    if (action === "approve" || action === "mark_safe" || action === "unpause") {
      status = "active";
      if (Number(existing.is_paid_post) === 1 && !existing.expires_at) {
        nextExpiresAt = new Date(Date.now() + PAID_POST_LIFETIME_DAYS * 24 * 3600 * 1000).toISOString();
      }
    } else if (action === "pause") {
      status = "paused";
    } else if (action === "mark_unsafe" || action === "reject") {
      status = "unsafe_removed";
    } else {
      return res.status(400).json({ error: "Invalid action" });
    }

    await db.execute({
      sql: `UPDATE listings SET status = ?, expires_at = ?, report_reason = CASE WHEN ? = 'active' THEN NULL ELSE report_reason END WHERE id = ?`,
      args: [status, nextExpiresAt, status, req.params.id],
    });
    res.json({ message: `Post status changed to ${status}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/users/:id/gift-posts", requireAdminKey, async (req, res) => {
  try {
    const count = Number(req.body.posts_count);
    if (!count || count < 1) return res.status(400).json({ error: "Enter valid posts count." });
    await db.execute({
      sql: `UPDATE users SET paid_post_credits = paid_post_credits + ? WHERE id = ?`,
      args: [count, req.params.id],
    });
    await db.execute({
      sql: `INSERT INTO post_purchases (id, user_id, plan_name, posts_added, amount_kes, payment_ref) VALUES (?, ?, 'Admin Gift', ?, 0, 'ADMIN-GIFT')`,
      args: [crypto.randomUUID(), req.params.id, count],
    });
    await addSellerNotification(
      req.params.id,
      `Admin gifted ${count} post credits to your account (paid posts run for ${PAID_POST_LIFETIME_DAYS} days).`
    );
    res.json({ message: `Gifted ${count} posts.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/users/:id/suspension", requireAdminKey, async (req, res) => {
  try {
    const { suspend, reason } = req.body;
    if (suspend) {
      await db.execute({
        sql: `UPDATE users SET is_suspended = 1, suspension_reason = ?, appeal_status = 'none' WHERE id = ?`,
        args: [reason || "Suspended for scamming / policy violation", req.params.id],
      });
      res.json({ message: "Account suspended." });
    } else {
      await db.execute({
        sql: `UPDATE users SET is_suspended = 0, suspension_reason = NULL, appeal_status = 'resolved' WHERE id = ?`,
        args: [req.params.id],
      });
      res.json({ message: "Account restored." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/settings", requireAdminKey, async (req, res) => {
  try {
    const { base_priority_price_kes } = req.body;
    await db.execute({
      sql: `INSERT OR REPLACE INTO settings (key, value) VALUES ('base_priority_price_kes', ?)`,
      args: [String(Number(base_priority_price_kes))],
    });
    res.json({ message: "Priority price updated." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/admin/plans/:id", requireAdminKey, async (req, res) => {
  try {
    const { name, post_count, price_kes } = req.body;
    await db.execute({
      sql: `UPDATE post_plans SET name = ?, post_count = ?, price_kes = ? WHERE id = ?`,
      args: [name, Number(post_count), Number(price_kes), req.params.id],
    });
    res.json({ message: "Plan updated." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/plans", requireAdminKey, async (req, res) => {
  try {
    const { name, post_count, price_kes } = req.body;
    await db.execute({
      sql: `INSERT INTO post_plans (id, name, post_count, price_kes) VALUES (?, ?, ?, ?)`,
      args: [crypto.randomUUID(), name, Number(post_count), Number(price_kes)],
    });
    res.json({ message: "Plan created." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/catalog", requireAdminKey, async (req, res) => {
  try {
    const { vehicle_type, brand, model, body_type } = req.body;
    if (!vehicle_type || !brand || !model || !body_type) {
      return res.status(400).json({ error: "All fields required." });
    }
    await db.execute({
      sql: `INSERT INTO vehicle_catalog (id, vehicle_type, brand, model, body_type) VALUES (?, ?, ?, ?, ?)`,
      args: [crypto.randomUUID(), vehicle_type.trim(), brand.trim(), model.trim(), body_type.trim()],
    });
    res.json({ message: "Catalog item added." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "API route not found" });
});

const port = process.env.PORT || 3000;
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMainModule) {
  ensureDbReady()
    .then(() => {
      app.listen(port, () => {
        console.log(`Wariara Cars Central Rift API running on http://localhost:${port}`);
      });
    })
    .catch((err) => {
      console.error("Startup failed:", err);
      process.exit(1);
    });
}

export default app;
