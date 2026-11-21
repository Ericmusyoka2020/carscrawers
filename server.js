
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
const allowedOrigins = (process.env.FRONTEND_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    const allowed = !origin || allowedOrigins.includes(origin) || /^https:\/\/[^.]+\.vercel\.app$/.test(origin || "");
    return callback(null, allowed);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-key", "x-sub-admin-session"],
}));
app.use(express.json({ limit: "15mb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "Wariara Cars Central Rift API" });
});

app.get("/", (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL;
  if (frontendUrl) return res.redirect(302, frontendUrl);
  res.json({ ok: true, service: "Wariara Cars Central Rift API", health: "/api/health" });
});
app.use(express.static(__dirname));
app.use("/public", express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  const requestOrigin = `${req.protocol}://${req.get("host")}`;
  const configuredApiBase = process.env.WARIARA_API_BASE || requestOrigin;
  const normalizedApiBase = /^https?:\/\/localhost(?::|\/)/.test(configuredApiBase) || /^https?:\/\/127\.0\.0\.1(?::|\/)/.test(configuredApiBase)
    ? configuredApiBase
    : configuredApiBase.replace(/^http:\/\//, "https://");
  res.json({
    apiBase: normalizedApiBase,
    payHeroBase: process.env.PAYHERO_BACKEND_URL || "",
    firebase: {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      measurementId: process.env.FIREBASE_MEASUREMENT_ID,
    },
  });
});

const ADMIN_SECRET = process.env.ADMIN_SECRET;
const PAID_POST_LIFETIME_DAYS = 70;
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;

if (!ADMIN_SECRET || !process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.warn("Missing required environment configuration. Check your .env file.");
}

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

function normalizeKenyanPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.startsWith("7") && digits.length === 9) return `254${digits}`;
  if (digits.startsWith("2540") && digits.length === 13) return `254${digits.slice(4)}`;
  if (digits.startsWith("254") && digits.length === 12) return digits;
  return String(phone || "").trim();
}

function phoneRegistryKey(phone) {
  return normalizeKenyanPhone(phone).replace(/\D/g, "");
}

function optionalText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function optionalNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function enrichListing(row) {
  const isExpiredByTime = Boolean(row.expires_at && new Date(row.expires_at).getTime() <= Date.now());
  const effectiveStatus = isExpiredByTime && row.status !== "unsafe_removed" ? "expired" : row.status;
  const priorityExpiresAt = row.priority_expires_at ? new Date(row.priority_expires_at) : null;
  const priorityRemainingHours = priorityExpiresAt && priorityExpiresAt.getTime() > Date.now()
    ? Math.ceil((priorityExpiresAt.getTime() - Date.now()) / (60 * 60 * 1000))
    : 0;
  return {
    ...row,
    status: effectiveStatus,
    days_remaining: row.expires_at ? computeRemainingDays(row.expires_at) : null,
    is_prioritized: priorityRemainingHours > 0 && Number(row.priority_amount_kes) > 0,
    priority_remaining_hours: priorityRemainingHours,
  };
}

async function expireOverdueListings() {
  await db.execute({
    sql: `UPDATE listings
          SET status = 'expired', priority_amount_kes = 0, priority_expires_at = NULL, priority_plan_name = NULL
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

async function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.admin_key;
  if (key && key === ADMIN_SECRET) return next();

  const subToken = req.headers["x-sub-admin-session"];
  if (subToken) {
    const r = await db.execute({ sql: `SELECT session_token_hash, session_expires_at FROM admin_sub_accounts WHERE id = 'primary'` });
    if (r.rows.length > 0) {
      const account = serializeRows(r.rows)[0];
      if (!account.session_expires_at || new Date(account.session_expires_at).getTime() <= Date.now()) {
        return res.status(401).json({ ok: false, error: "Sub-admin session expired." });
      }
      if (hashToken(String(subToken)) === account.session_token_hash) return next();
    }
  }
  return res.status(401).json({ ok: false, error: "Invalid Admin Portal authentication." });
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
      ["appeal_count", "INTEGER DEFAULT 0"],
      ["firebase_uid", "TEXT"],
      ["appeal_response", "TEXT"],
      ["agent_of", "TEXT"],
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
    if (!existingListCols.has("priority_plan_name")) {
      await db.execute(`ALTER TABLE listings ADD COLUMN priority_plan_name TEXT`);
    }
    if (!existingListCols.has("whatsapp_phone")) {
      await db.execute(`ALTER TABLE listings ADD COLUMN whatsapp_phone TEXT`);
    }
    if (!existingListCols.has("call_phone")) {
      await db.execute(`ALTER TABLE listings ADD COLUMN call_phone TEXT`);
    }
  }

  const resetInfo = await db.execute(`PRAGMA table_info(password_resets)`);
  const resetCols = new Set(resetInfo.rows.map((row) => String(row.name)));
  if (!resetCols.has("attempts")) {
    await db.execute(`ALTER TABLE password_resets ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
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
      appeal_count INTEGER DEFAULT 0,
      firebase_uid TEXT,
      appeal_response TEXT,
      agent_of TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS admin_sub_accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      two_factor_enabled INTEGER DEFAULT 0,
      code_hash TEXT,
      code_expires_at DATETIME,
      code_used_at DATETIME,
      session_token_hash TEXT,
      session_expires_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS whatsapp_phone_registry (
      phone_key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
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
    `CREATE TABLE IF NOT EXISTS priority_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      duration_hours INTEGER NOT NULL,
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

  const priorityPlanCount = await db.execute(`SELECT COUNT(*) AS cnt FROM priority_plans`);
  if (Number(priorityPlanCount.rows[0].cnt) === 0) {
    await db.execute({
      sql: `INSERT INTO priority_plans (id, name, duration_hours, price_kes) VALUES (?, ?, ?, ?)`,
      args: [crypto.randomUUID(), "24 Hours", 24, 300],
    });
  }

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

  await db.execute(`DELETE FROM whatsapp_phone_registry`);
  const usersForPhoneRegistry = await db.execute(`SELECT id, whatsapp_phone FROM users WHERE whatsapp_phone != ''`);
  for (const user of serializeRows(usersForPhoneRegistry.rows)) {
    const phoneKey = phoneRegistryKey(user.whatsapp_phone);
    if (phoneKey) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO whatsapp_phone_registry (phone_key, user_id) VALUES (?, ?)`,
        args: [phoneKey, user.id],
      });
    }
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
      firebase_uid,
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

    const normalizedWhatsApp = normalizeKenyanPhone(whatsapp_phone);
    const phoneKey = phoneRegistryKey(normalizedWhatsApp);
    if (!phoneKey) return res.status(400).json({ error: "Enter a valid WhatsApp number." });
    const registeredPhone = await db.execute({
      sql: `SELECT user_id FROM whatsapp_phone_registry WHERE phone_key = ?`,
      args: [phoneKey],
    });
    if (registeredPhone.rows.length > 0) {
      return res.status(409).json({ error: "This WhatsApp number is already used by another account." });
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

    try {
      await db.execute({
        sql: `INSERT INTO whatsapp_phone_registry (phone_key, user_id) VALUES (?, ?)`,
        args: [phoneKey, id],
      });
    } catch (err) {
      if (String(err.message).includes("UNIQUE constraint failed")) {
        return res.status(409).json({ error: "This WhatsApp number is already used by another account." });
      }
      throw err;
    }

    try {
      await db.execute({
        sql: `INSERT INTO users (id, name, phone, email, password_hash, whatsapp_phone, call_phone, role, shop_slug, town)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          name.trim(),
          cleanPhone,
          cleanEmail,
          passwordHash,
          normalizedWhatsApp,
          call_phone.trim(),
          safeRole,
          slug,
          town,
        ],
      });
    } catch (err) {
      await db.execute({
        sql: `DELETE FROM whatsapp_phone_registry WHERE phone_key = ? AND user_id = ?`,
        args: [phoneKey, id],
      });
      throw err;
    }

    if (firebase_uid) {
      await db.execute({ sql: `UPDATE users SET firebase_uid = ? WHERE id = ?`, args: [String(firebase_uid), id] });
    }
    await addSellerNotification(id, "Account created. You have 6 free posts available.");
    const created = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [id] });
    res.status(201).json({ user: sanitizeUser(serializeRows(created.rows)[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sellers/login", async (req, res) => {
  try {
    const { email, password, firebase_uid } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });
    const cleanEmail = email.trim().toLowerCase();
    const r = await db.execute({ sql: `SELECT * FROM users WHERE email = ?`, args: [cleanEmail] });
    if (r.rows.length === 0) return res.status(404).json({ error: "Seller account not found." });
    const user = serializeRows(r.rows)[0];
    if (firebase_uid) {
      if (user.firebase_uid && user.firebase_uid !== String(firebase_uid)) {
        return res.status(401).json({ error: "This Firebase account does not match the seller account." });
      }
      await db.execute({ sql: `UPDATE users SET firebase_uid = ? WHERE id = ?`, args: [String(firebase_uid), user.id] });
      const updated = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [user.id] });
      return res.json({ user: sanitizeUser(serializeRows(updated.rows)[0]) });
    }
    if (!password) return res.status(400).json({ error: "Password is required." });
    if (!user.password_hash) {
      return res.status(400).json({ error: "No password is set on this account yet. Use Forgot Password to set one." });
    }
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sellers/forgot-password/code", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Enter your account email address." });
    const cleanEmail = email.trim().toLowerCase();
    const r = await db.execute({ sql: `SELECT * FROM users WHERE email = ?`, args: [cleanEmail] });
    if (r.rows.length === 0) {
      return res.json({ message: "If an account exists for that email, a reset code has been sent." });
    }
    const user = serializeRows(r.rows)[0];

    await db.execute({
      sql: `UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL`,
      args: [user.id],
    });

    const resetCode = String(crypto.randomInt(100000, 1000000));
    const tokenHash = hashToken(resetCode);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await db.execute({
      sql: `INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
      args: [crypto.randomUUID(), user.id, tokenHash, expiresAt],
    });

    const publicKey = process.env.EMAILJS_PUBLIC_KEY;
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;
    if (!publicKey || !privateKey) {
      await db.execute({
        sql: `UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND used_at IS NULL`,
        args: [tokenHash],
      });
      return res.status(503).json({ error: "Password reset email is not configured. Please contact support." });
    }

    const mailResponse = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: publicKey,
        accessToken: privateKey,
        template_params: {
          to_email: cleanEmail,
          to_name: user.name,
          name: "Wariara Cars Central Rift",
          from_name: "Wariara Cars Central Rift",
          subject: "Your Wariara Cars password reset code",
          message: `Your password reset code is ${resetCode}. It is valid for 10 minutes. If you did not request this, you can ignore this email.`,
          reset_code: resetCode,
          code_expiry_minutes: "10",
        },
      }),
    });
    if (!mailResponse.ok) {
      const providerMessage = await mailResponse.text();
      await db.execute({
        sql: `UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND used_at IS NULL`,
        args: [tokenHash],
      });
      console.error("Password reset email delivery failed:", mailResponse.status, providerMessage);
      return res.status(502).json({ error: "Could not send the reset email. Please try again later." });
    }

    res.json({ message: "If an account exists for that email, a 6-digit reset code has been sent. It expires in 10 minutes." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sellers/forgot-password/verify", async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: "Enter your account email and reset code." });
    const userResult = await db.execute({
      sql: `SELECT id FROM users WHERE email = ?`,
      args: [String(email).trim().toLowerCase()],
    });
    if (userResult.rows.length === 0) return res.status(400).json({ error: "Invalid or expired reset code." });

    const userId = String(userResult.rows[0].id);
    const resetResult = await db.execute({
      sql: `SELECT * FROM password_resets WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      args: [userId],
    });
    if (resetResult.rows.length === 0) return res.status(400).json({ error: "Invalid or expired reset code." });
    const reset = serializeRows(resetResult.rows)[0];
    if (Number(reset.attempts) >= 5 || new Date(reset.expires_at).getTime() <= Date.now()) {
      await db.execute({
        sql: `UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL`,
        args: [reset.id],
      });
      return res.status(400).json({ error: "Invalid or expired reset code. Request a new code." });
    }

    const submittedHash = hashToken(String(code).trim());
    const expectedHash = Buffer.from(String(reset.token_hash), "hex");
    const actualHash = Buffer.from(submittedHash, "hex");
    if (expectedHash.length !== actualHash.length || !crypto.timingSafeEqual(expectedHash, actualHash)) {
      await db.execute({
        sql: `UPDATE password_resets SET attempts = attempts + 1,
              used_at = CASE WHEN attempts + 1 >= 5 THEN CURRENT_TIMESTAMP ELSE used_at END
              WHERE id = ? AND used_at IS NULL`,
        args: [reset.id],
      });
      return res.status(400).json({ error: "Invalid or expired reset code." });
    }

    const consumed = await db.execute({
      sql: `UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL AND attempts < 5`,
      args: [reset.id],
    });
    if (Number(consumed.rowsAffected || 0) === 0) {
      return res.status(400).json({ error: "Invalid or expired reset code." });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    await db.execute({
      sql: `INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        userId,
        hashToken(resetToken),
        new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      ],
    });
    res.json({ reset_token: resetToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Consumes the verified reset token once so it can never be reused.
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
    if (r.rows.length === 0) return res.status(400).json({ error: "Invalid password reset token." });

    const resetRow = serializeRows(r.rows)[0];
    if (resetRow.used_at) {
      return res.status(400).json({ error: "This reset token has already been used and cannot be reused." });
    }
    if (new Date(resetRow.expires_at).getTime() <= Date.now()) {
      return res.status(400).json({ error: "This reset token has expired. Request a new code." });
    }

    const consumed = await db.execute({
      sql: `UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL`,
      args: [resetRow.id],
    });
    if (Number(consumed.rowsAffected || 0) === 0) {
      return res.status(400).json({ error: "This reset token has already been used." });
    }

    await db.execute({
      sql: `UPDATE users SET password_hash = ? WHERE id = ?`,
      args: [hashPassword(password), resetRow.user_id],
    });

    const updated = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [resetRow.user_id] });
    res.json({
      message: "Password updated successfully. This reset token cannot be reused.",
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
    const account = await db.execute({ sql: `SELECT appeal_count, is_suspended FROM users WHERE id = ?`, args: [req.params.id] });
    if (account.rows.length === 0) return res.status(404).json({ error: "Account not found." });
    const current = serializeRows(account.rows)[0];
    if (!current.is_suspended) return res.status(400).json({ error: "Only suspended accounts can request review." });
    if (Number(current.appeal_count || 0) >= 2) return res.status(429).json({ error: "You have used both review requests for this suspension." });
    await db.execute({
      sql: `UPDATE users SET appeal_text = ?, appeal_status = 'pending', appeal_count = appeal_count + 1 WHERE id = ?`,
      args: [appeal_text.trim(), req.params.id],
    });
    res.json({ message: "Suspension review request sent to Admin and Admin Sub." });
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
// PUBLIC MARKETPLACE & PRIORITY API (APPROVED AVAILABLE POSTS)
// ==========================================
app.get("/api/meta", async (req, res) => {
  try {
    const catalog = await db.execute(`SELECT * FROM vehicle_catalog ORDER BY brand ASC, model ASC`);
    const plans = await db.execute(`SELECT * FROM post_plans WHERE active = 1 ORDER BY price_kes ASC`);
    const priorityPlans = await db.execute(
      `SELECT * FROM priority_plans WHERE active = 1 ORDER BY duration_hours ASC, price_kes ASC`
    );
    const settingsRows = await db.execute(`SELECT * FROM settings`);
    const settings = {};
    for (const r of settingsRows.rows) settings[r.key] = r.value;
    res.json({
      catalog: serializeRows(catalog.rows),
      plans: serializeRows(plans.rows),
      priorityPlans: serializeRows(priorityPlans.rows),
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

    const baseFee = settings.base_priority_price_kes || 300;

    const slotsRes = await db.execute({
      sql: `SELECT l.id, l.title, l.category, l.priority_amount_kes, l.priority_expires_at,
                   l.priority_plan_name, u.name AS seller_name
            FROM listings l
            JOIN users u ON u.id = l.seller_id
            WHERE l.status = 'active' AND u.is_suspended = 0
              AND (l.expires_at IS NULL OR l.expires_at > CURRENT_TIMESTAMP)
              AND l.priority_amount_kes > 0 AND l.priority_expires_at > CURRENT_TIMESTAMP
            ORDER BY l.priority_amount_kes DESC, l.priority_expires_at DESC, l.created_at DESC`,
      args: [],
    });

    const slots = serializeRows(slotsRes.rows);
    const highestBid = slots.length > 0 ? slots[0].priority_amount_kes : 0;

    res.json({
      baseFee,
      usedSlots: slots.length,
      highestBid,
      recommendedForTop1: baseFee,
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
               COALESCE(NULLIF(l.whatsapp_phone, ''), u.whatsapp_phone) AS effective_whatsapp_phone,
               COALESCE(NULLIF(l.call_phone, ''), u.call_phone) AS effective_call_phone,
               (SELECT photo_data FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.sort_order ASC LIMIT 1) AS cover_photo,
               (SELECT COUNT(*) FROM listing_photos p WHERE p.listing_id = l.id) AS photo_count,
               CASE WHEN l.status = 'active' AND l.priority_amount_kes > 0 AND l.priority_expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS is_sponsored,
               CASE WHEN l.status = 'active' AND l.priority_amount_kes > 0 AND l.priority_expires_at > CURRENT_TIMESTAMP THEN l.priority_amount_kes ELSE 0 END AS effective_priority,
               ROW_NUMBER() OVER (PARTITION BY l.seller_id ORDER BY l.created_at DESC) AS seller_slot
        FROM listings l
        JOIN users u ON u.id = l.seller_id
        WHERE ${where.join(" AND ")}
      )
      SELECT * FROM ranked l ORDER BY ${orderBy} LIMIT 100
    `;
    const rows = await db.execute({ sql, args });
    const listings = serializeRows(rows.rows).map((row) => {
      row.whatsapp_phone = row.effective_whatsapp_phone;
      row.call_phone = row.effective_call_phone;
      delete row.effective_whatsapp_phone;
      delete row.effective_call_phone;
      return enrichListing(row);
    });
    res.json({ listings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/listings/:id", async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT l.*, u.name AS seller_name, u.role AS seller_role, u.shop_slug AS seller_slug,
                   COALESCE(NULLIF(l.whatsapp_phone, ''), u.whatsapp_phone) AS effective_whatsapp_phone,
                   COALESCE(NULLIF(l.call_phone, ''), u.call_phone) AS effective_call_phone,
                   u.town AS seller_town
            FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?`,
      args: [req.params.id],
    });
    if (r.rows.length === 0) return res.status(404).json({ error: "Not found" });
    const listingRow = serializeRows(r.rows)[0];
    listingRow.whatsapp_phone = listingRow.effective_whatsapp_phone;
    listingRow.call_phone = listingRow.effective_call_phone;
    delete listingRow.effective_whatsapp_phone;
    delete listingRow.effective_call_phone;
    const listing = enrichListing(listingRow);
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
      sql: `UPDATE listings SET report_reason = ?, reported_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [reason.trim(), req.params.id],
    });
    res.json({ message: "Your report has been sent to Wariara Cars Central Rift for direct post review. The post will remain visible while it is reviewed." });
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
    const priceNum = optionalNumber(b.price_kes) ?? 0;
    const town = String(b.town || seller.town || "").trim();
    const description = String(b.description || "").trim();

    const hasListingInformation = Boolean(description || b.year || b.brand || b.model || b.part_name || b.part_make || b.part_model || b.price_kes);
    if (!hasListingInformation) return res.status(400).json({ error: "Enter at least one listing detail or a description." });
    if (priceNum < 0) return res.status(400).json({ error: "Price cannot be negative." });

    const photos = Array.isArray(b.photos) ? b.photos : [];
    if (photos.length < 1) return res.status(400).json({ error: "Add at least 1 photo." });
    if (photos.length > 5) return res.status(400).json({ error: "A listing may contain at most 5 photos." });
    if (photos.some((photo) => typeof photo !== "string")) {
      return res.status(400).json({ error: "Listing photos must be image data." });
    }

    const useFreePost = freeLeft > 0;
    const expiresAt = useFreePost
      ? null
      : new Date(Date.now() + PAID_POST_LIFETIME_DAYS * 24 * 3600 * 1000).toISOString();

    const id = crypto.randomUUID();
    const title =
      category === "motor"
        ? [optionalText(b.year), optionalText(b.brand), optionalText(b.model)].filter(Boolean).join(" ") || "Motor listing"
        : [optionalText(b.part_name), optionalText(b.part_make), optionalText(b.part_model)].filter(Boolean).join(" ") ||
          "Spare parts listing";

    await db.execute({
      sql: `INSERT INTO listings (
        id, seller_id, category, title, price_kes, negotiable, town, description,
        vehicle_type, reg_number, condition_type, brand, model, body_type, year,
        fuel_type, transmission, drive_type, air_con, engine_cc, mileage_km,
        part_name, part_make, part_model, year_from, year_to, part_condition, part_authenticity,
        whatsapp_phone, call_phone, is_paid_post, expires_at, status
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'pending_approval'
      )`,
      args: [
        id,
        seller.id,
        category,
        title,
        priceNum,
        b.negotiable === "No" ? "No" : "Yes",
        town,
        description,
        category === "motor" ? optionalText(b.vehicle_type) : null,
        category === "motor" ? optionalText(b.reg_number) : null,
        category === "motor" ? optionalText(b.condition_type) : null,
        category === "motor" ? optionalText(b.brand) : null,
        category === "motor" ? optionalText(b.model) : null,
        category === "motor" ? optionalText(b.body_type) : null,
        category === "motor" ? optionalNumber(b.year) : null,
        category === "motor" ? optionalText(b.fuel_type) : null,
        category === "motor" ? optionalText(b.transmission) : null,
        category === "motor" ? optionalText(b.drive_type) : null,
        category === "motor" ? optionalText(b.air_con) : null,
        category === "motor" ? optionalNumber(b.engine_cc) : null,
        category === "motor" ? optionalNumber(b.mileage_km) : null,
        category === "part" ? optionalText(b.part_name) : null,
        category === "part" ? optionalText(b.part_make) : null,
        category === "part" ? optionalText(b.part_model) : null,
        category === "part" ? optionalNumber(b.year_from) : null,
        category === "part" ? optionalNumber(b.year_to) : null,
        category === "part" ? optionalText(b.part_condition) : null,
        category === "part" ? optionalText(b.part_authenticity) : null,
        normalizeKenyanPhone(seller.whatsapp_phone),
        seller.call_phone || seller.phone || null,
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

    if (!b.seller_id || b.seller_id !== existing.seller_id) {
      return res.status(403).json({ error: "Only the post owner can edit this listing." });
    }

    const text = (key) => Object.hasOwn(b, key) ? optionalText(b[key]) : existing[key];
    const number = (key) => Object.hasOwn(b, key) ? optionalNumber(b[key]) : existing[key];
    const description = String(b.description ?? existing.description ?? "").trim();
    if (!description) return res.status(400).json({ error: "A description is required." });
    const price = Object.hasOwn(b, "price_kes") ? optionalNumber(b.price_kes) ?? 0 : Number(existing.price_kes);
    if (price < 0) return res.status(400).json({ error: "Price cannot be negative." });
    const next = {
      vehicle_type: text("vehicle_type"),
      reg_number: text("reg_number"),
      condition_type: text("condition_type"),
      brand: text("brand"),
      model: text("model"),
      body_type: text("body_type"),
      year: number("year"),
      fuel_type: text("fuel_type"),
      transmission: text("transmission"),
      drive_type: text("drive_type"),
      air_con: text("air_con"),
      engine_cc: number("engine_cc"),
      mileage_km: number("mileage_km"),
      part_name: text("part_name"),
      part_make: text("part_make"),
      part_model: text("part_model"),
      year_from: number("year_from"),
      year_to: number("year_to"),
      part_condition: text("part_condition"),
      part_authenticity: text("part_authenticity"),
      whatsapp_phone: Object.hasOwn(b, "whatsapp_phone")
        ? (optionalText(b.whatsapp_phone) ? normalizeKenyanPhone(b.whatsapp_phone) : null)
        : existing.whatsapp_phone,
      call_phone: text("call_phone"),
    };
    const title = existing.category === "motor"
      ? [next.year, next.brand, next.model].filter(Boolean).join(" ") || "Motor listing"
      : [next.part_name, next.part_make, next.part_model].filter(Boolean).join(" ") || "Spare parts listing";

    await db.execute({
      sql: `UPDATE listings SET
        title = ?, price_kes = ?, negotiable = ?, town = ?, description = ?,
        vehicle_type = ?, reg_number = ?, condition_type = ?, brand = ?, model = ?, body_type = ?,
        year = ?, fuel_type = ?, transmission = ?, drive_type = ?, air_con = ?, engine_cc = ?, mileage_km = ?,
        part_name = ?, part_make = ?, part_model = ?, year_from = ?, year_to = ?, part_condition = ?, part_authenticity = ?,
        whatsapp_phone = ?, call_phone = ?
        WHERE id = ?`,
      args: [
        title,
        price,
        b.negotiable === "No" ? "No" : "Yes",
        String(b.town ?? existing.town ?? "").trim(),
        description,
        next.vehicle_type,
        next.reg_number,
        next.condition_type,
        next.brand,
        next.model,
        next.body_type,
        next.year,
        next.fuel_type,
        next.transmission,
        next.drive_type,
        next.air_con,
        next.engine_cc,
        next.mileage_km,
        next.part_name,
        next.part_make,
        next.part_model,
        next.year_from,
        next.year_to,
        next.part_condition,
        next.part_authenticity,
        next.whatsapp_phone,
        next.call_phone,
        req.params.id,
      ],
    });

    if (Array.isArray(b.photos)) {
      if (b.photos.some((photo) => typeof photo !== "string")) {
        return res.status(400).json({ error: "Listing photos must be image data." });
      }
      if (b.photos.length > 5) return res.status(400).json({ error: "A listing may contain at most 5 photos." });
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

    if (!seller_id || seller_id !== existing.seller_id) return res.status(403).json({ error: "Unauthorized" });
    if (existing.status === "expired") {
      return res.status(403).json({ error: "This post has expired after 70 days." });
    }
    if (["pending_approval", "reported_suspended", "unsafe_removed"].includes(existing.status)) {
      return res.status(403).json({ error: "Listing is currently under Admin approval or safety review." });
    }

    await db.execute({
      sql: `UPDATE listings
            SET status = ?,
                priority_amount_kes = CASE WHEN ? = 'sold' THEN 0 ELSE priority_amount_kes END,
                priority_expires_at = CASE WHEN ? = 'sold' THEN NULL ELSE priority_expires_at END,
                priority_plan_name = CASE WHEN ? = 'sold' THEN NULL ELSE priority_plan_name END
            WHERE id = ?`,
      args: [status, status, status, status, req.params.id],
    });
    res.json({ message: `Post marked as ${status}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/listings/:id", async (req, res) => {
  try {
    const sellerId = req.body?.seller_id || req.query.seller_id;
    const listing = await db.execute({
      sql: `SELECT seller_id FROM listings WHERE id = ?`,
      args: [req.params.id],
    });
    if (listing.rows.length === 0) return res.status(404).json({ error: "Listing not found." });
    if (!sellerId || sellerId !== listing.rows[0].seller_id) {
      return res.status(403).json({ error: "Only the post owner can delete this listing." });
    }

    await db.execute({ sql: `DELETE FROM listing_photos WHERE listing_id = ?`, args: [req.params.id] });
    await db.execute({ sql: `DELETE FROM listings WHERE id = ?`, args: [req.params.id] });
    res.json({ message: "Listing deleted." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/listings/:id/prioritize", async (req, res) => {
  try {
    const { seller_id, priority_plan_id } = req.body;
    const paymentRef = req.body.payment_ref || "PAYHERO";
    const payerPhone = req.body.payer_phone || "";

    const lRes = await db.execute({
      sql: `SELECT l.*, u.name AS seller_name, u.email AS seller_email,
                   u.whatsapp_phone AS account_whatsapp_phone, u.call_phone AS account_call_phone
            FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?`,
      args: [req.params.id],
    });
    if (lRes.rows.length === 0) return res.status(404).json({ error: "Listing not found." });
    const targetListing = enrichListing(serializeRows(lRes.rows)[0]);
    if (!seller_id || seller_id !== targetListing.seller_id) {
      return res.status(403).json({ error: "Only the post owner can prioritize this listing." });
    }
    if (targetListing.status !== "active") {
      return res.status(400).json({ error: "Only active approved posts can be prioritized." });
    }

    const planResult = await db.execute({
      sql: `SELECT * FROM priority_plans WHERE id = ? AND active = 1`,
      args: [priority_plan_id],
    });
    if (planResult.rows.length === 0) return res.status(404).json({ error: "Priority plan not found." });
    const plan = serializeRows(planResult.rows)[0];
    const priorityExpiresAt = new Date(Date.now() + Number(plan.duration_hours) * 60 * 60 * 1000).toISOString();

    await db.execute({
      sql: `UPDATE listings SET priority_amount_kes = ?, priority_expires_at = ?, priority_plan_name = ? WHERE id = ?`,
      args: [plan.price_kes, priorityExpiresAt, plan.name, req.params.id],
    });

    await addSellerNotification(
      targetListing.seller_id,
      `Payment confirmed (KES ${plan.price_kes}): Post "${targetListing.title}" prioritized for ${plan.duration_hours} hours (${plan.name}).`
    );

    await addAdminPaymentNotification({
      payerId: targetListing.seller_id,
      payerName: targetListing.seller_name,
      payerEmail: targetListing.seller_email,
      payerPhone: payerPhone || targetListing.whatsapp_phone || targetListing.account_whatsapp_phone ||
        targetListing.call_phone || targetListing.account_call_phone,
      amountKes: plan.price_kes,
      purpose: `Prioritise Post (${plan.name}, ${plan.duration_hours}h): ${targetListing.title}`,
      reference: paymentRef,
    });

    res.json({
      message: `Payment confirmed! "${targetListing.title}" is prioritized for ${plan.duration_hours} hours (${plan.name}).`,
      priority_expires_at: priorityExpiresAt,
    });
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
      SELECT l.*, u.name AS seller_name, u.email AS seller_email,
             u.whatsapp_phone AS account_whatsapp_phone, u.call_phone AS account_call_phone,
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
    const priorityPlans = await db.execute(`SELECT * FROM priority_plans ORDER BY duration_hours ASC, price_kes ASC`);
    const catalog = await db.execute(`SELECT * FROM vehicle_catalog ORDER BY brand ASC, model ASC`);
    const sRows = await db.execute(`SELECT * FROM settings`);
    const settings = {};
    for (const r of sRows.rows) settings[r.key] = r.value;

    const listings = serializeRows(listingsRes.rows).map((listing) => {
      listing.whatsapp_phone = listing.whatsapp_phone || listing.account_whatsapp_phone;
      listing.call_phone = listing.call_phone || listing.account_call_phone;
      delete listing.account_whatsapp_phone;
      delete listing.account_call_phone;
      return enrichListing(listing);
    });

    res.json({
      listings,
      users: serializeRows(users.rows).map(sanitizeUser),
      paymentNotifications: serializeRows(paymentNotifications.rows),
      plans: serializeRows(plans.rows),
      priorityPlans: serializeRows(priorityPlans.rows),
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

app.put("/api/admin/listings/:id", requireAdminKey, async (req, res) => {
  try {
    const listing = await db.execute({
      sql: `SELECT id FROM listings WHERE id = ?`,
      args: [req.params.id],
    });
    if (listing.rows.length === 0) return res.status(404).json({ error: "Listing not found." });

    const { title, price_kes, town, description } = req.body;
    if (!String(title || "").trim() || !String(description || "").trim()) {
      return res.status(400).json({ error: "Title and description are required." });
    }
    const price = optionalNumber(price_kes) ?? 0;
    if (price < 0) return res.status(400).json({ error: "Price cannot be negative." });

    await db.execute({
      sql: `UPDATE listings SET title = ?, price_kes = ?, town = ?, description = ? WHERE id = ?`,
      args: [
        String(title).trim(),
        price,
        String(town || "").trim(),
        String(description).trim(),
        req.params.id,
      ],
    });
    res.json({ message: "Listing updated." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/admin/users/:id/profile", requireAdminKey, async (req, res) => {
  try {
    const userResult = await db.execute({
      sql: `SELECT * FROM users WHERE id = ?`,
      args: [req.params.id],
    });
    if (userResult.rows.length === 0) return res.status(404).json({ error: "Account not found." });
    const existing = serializeRows(userResult.rows)[0];

    const { name, role, town, whatsapp_phone, call_phone, agent_of } = req.body;
    if (!String(name ?? existing.name).trim() || !["private", "dealer"].includes(role)) {
      return res.status(400).json({ error: "Enter a name and a valid account type." });
    }
    let agentId = agent_of || null;
    if (agentId) {
      const dealer = await db.execute({
        sql: `SELECT id FROM users WHERE id = ? AND role = 'dealer' AND is_suspended = 0`,
        args: [agentId],
      });
      if (dealer.rows.length === 0 || agentId === req.params.id) {
        return res.status(400).json({ error: "Select an active dealership for this agent." });
      }
    }
    if (role === "dealer") agentId = null;

    const normalizedWhatsApp = normalizeKenyanPhone(whatsapp_phone ?? existing.whatsapp_phone);
    const phoneKey = phoneRegistryKey(normalizedWhatsApp);
    if (phoneKey) {
      const registeredPhone = await db.execute({
        sql: `SELECT user_id FROM whatsapp_phone_registry WHERE phone_key = ?`,
        args: [phoneKey],
      });
      if (registeredPhone.rows.some((row) => row.user_id !== req.params.id)) {
        return res.status(409).json({ error: "This WhatsApp number is already used by another account." });
      }
      if (registeredPhone.rows.length === 0) {
        try {
          await db.execute({
            sql: `INSERT INTO whatsapp_phone_registry (phone_key, user_id) VALUES (?, ?)`,
            args: [phoneKey, req.params.id],
          });
        } catch (err) {
          if (String(err.message).includes("UNIQUE constraint failed")) {
            return res.status(409).json({ error: "This WhatsApp number is already used by another account." });
          }
          throw err;
        }
      }
    }

    try {
      await db.execute({
        sql: `UPDATE users SET name = ?, role = ?, town = ?, whatsapp_phone = ?, call_phone = ?, agent_of = ? WHERE id = ?`,
        args: [
          String(name ?? existing.name).trim(),
          role,
          String(town ?? existing.town ?? "").trim(),
          normalizedWhatsApp,
          String(call_phone ?? existing.call_phone ?? "").trim(),
          agentId,
          req.params.id,
        ],
      });
    } catch (err) {
      if (phoneKey && phoneKey !== phoneRegistryKey(existing.whatsapp_phone)) {
        await db.execute({
          sql: `DELETE FROM whatsapp_phone_registry WHERE phone_key = ? AND user_id = ?`,
          args: [phoneKey, req.params.id],
        });
      }
      throw err;
    }
    await db.execute({
      sql: `DELETE FROM whatsapp_phone_registry WHERE user_id = ? AND phone_key != ?`,
      args: [req.params.id, phoneKey],
    });
    res.json({ message: agentId ? "Dealership agent updated." : "Account updated." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/users/:id/gift-posts", requireAdminKey, async (req, res) => {
  try {
    const count = Number(req.body.posts_count);
    const confirmPhone = String(req.body.confirm_whatsapp || "").trim();
    if (!count || count < 1) return res.status(400).json({ error: "Enter valid posts count." });
    if (!confirmPhone) return res.status(400).json({ error: "Enter the seller's registered WhatsApp number." });
    const target = await db.execute({ sql: `SELECT whatsapp_phone, name FROM users WHERE id = ?`, args: [req.params.id] });
    if (target.rows.length === 0) return res.status(404).json({ error: "Account not found." });
    const targetUser = serializeRows(target.rows)[0];
    if (phoneRegistryKey(targetUser.whatsapp_phone) !== phoneRegistryKey(confirmPhone)) {
      return res.status(400).json({ error: "Gift cancelled: the WhatsApp number does not match this account." });
    }
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
        sql: `UPDATE users SET is_suspended = 1, suspension_reason = ?, appeal_status = 'none', appeal_count = 0 WHERE id = ?`,
        args: [reason || "Suspended for scamming / policy violation", req.params.id],
      });
      await db.execute({ sql: `UPDATE listings SET status = 'paused' WHERE seller_id = ? AND status IN ('active', 'pending_approval')`, args: [req.params.id] });
      await addSellerNotification(req.params.id, `Account suspended: ${reason || "Policy review required"}. All posts are paused.`);
      res.json({ message: "Account suspended and all posts paused." });
    } else {
      await db.execute({
        sql: `UPDATE users SET is_suspended = 0, suspension_reason = NULL, appeal_status = 'resolved', appeal_count = 0 WHERE id = ?`,
        args: [req.params.id],
      });
      await db.execute({ sql: `UPDATE listings SET status = 'active' WHERE seller_id = ? AND status = 'paused'`, args: [req.params.id] });
      await addSellerNotification(req.params.id, "Account restored. Your paused posts are active again.");
      res.json({ message: "Account restored and posts unpaused." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/users/:id/appeal", requireAdminKey, async (req, res) => {
  try {
    const { action, response } = req.body;
    if (!["accept", "reject"].includes(action)) return res.status(400).json({ error: "Invalid appeal action." });
    const message = String(response || "").trim();
    if (!message) return res.status(400).json({ error: "Enter a response for the seller." });

    await db.execute({
      sql: `UPDATE users SET appeal_status = ?, appeal_response = ? WHERE id = ?`,
      args: [action === "accept" ? "accepted" : "rejected", message, req.params.id],
    });
    await addSellerNotification(req.params.id, `Suspension appeal ${action === "accept" ? "accepted" : "rejected"}: ${message}`);

    if (action === "accept") {
      await db.execute({ sql: `UPDATE users SET is_suspended = 0, suspension_reason = NULL, appeal_count = 0 WHERE id = ?`, args: [req.params.id] });
      await db.execute({ sql: `UPDATE listings SET status = 'active' WHERE seller_id = ? AND status = 'paused'`, args: [req.params.id] });
    }
    res.json({ message: `Appeal ${action === "accept" ? "accepted and account restored" : "rejected"}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/sub-account", requireAdminKey, async (req, res) => {
  try {
    const { email, password, two_factor_enabled } = req.body;
    if (!email || !password || password.length < 6) return res.status(400).json({ error: "A valid sub-admin email and password of at least 6 characters are required." });
    await db.execute({
      sql: `INSERT INTO admin_sub_accounts (id, email, password_hash, two_factor_enabled, updated_at)
            VALUES ('primary', ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash,
            two_factor_enabled = excluded.two_factor_enabled, updated_at = CURRENT_TIMESTAMP`,
      args: [String(email).trim().toLowerCase(), hashPassword(password), two_factor_enabled ? 1 : 0],
    });
    res.json({ message: "Sub-admin password and email updated." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/sub/login", async (req, res) => {
  try {
    const { password } = req.body;
    const r = await db.execute({ sql: `SELECT * FROM admin_sub_accounts WHERE id = 'primary'` });
    if (r.rows.length === 0) return res.status(401).json({ error: "Sub-admin is not registered." });
    const account = serializeRows(r.rows)[0];
    if (!verifyPassword(String(password || ""), account.password_hash)) return res.status(401).json({ error: "Invalid sub-admin password." });

    if (!Number(account.two_factor_enabled)) {
      const token = crypto.randomBytes(32).toString("hex");
      await db.execute({ sql: `UPDATE admin_sub_accounts SET session_token_hash = ?, session_expires_at = ? WHERE id = 'primary'`, args: [hashToken(token), new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()] });
      return res.json({ session_token: token, requires_code: false });
    }

    const code = String(crypto.randomInt(100000, 1000000));
    await db.execute({ sql: `UPDATE admin_sub_accounts SET code_hash = ?, code_expires_at = ?, code_used_at = NULL WHERE id = 'primary'`, args: [hashToken(code), new Date(Date.now() + 10 * 60 * 1000).toISOString()] });
    const publicKey = process.env.EMAILJS_PUBLIC_KEY;
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;
    if (!publicKey || !privateKey) return res.status(503).json({ error: "Email verification is not configured." });
    const mail = await fetch("https://api.emailjs.com/api/v1.0/email/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: publicKey, accessToken: privateKey, template_params: { to_email: account.email, subject: "Wariara sub-admin security code", message: `Your 3D security code is ${code}. It expires in 10 minutes.`, code, code_expiry_minutes: "10" } }) });
    if (!mail.ok) return res.status(502).json({ error: "Could not send the security code." });
    res.json({ requires_code: true, email_hint: account.email.replace(/(^.).*(@.*$)/, "$1***$2") });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/sub/verify", async (req, res) => {
  try {
    const { password, code } = req.body;
    const r = await db.execute({ sql: `SELECT * FROM admin_sub_accounts WHERE id = 'primary'` });
    if (r.rows.length === 0) return res.status(401).json({ error: "Sub-admin is not registered." });
    const account = serializeRows(r.rows)[0];
    if (!verifyPassword(String(password || ""), account.password_hash)) return res.status(401).json({ error: "Invalid sub-admin password." });
    if (account.code_used_at || !account.code_expires_at || new Date(account.code_expires_at).getTime() <= Date.now()) return res.status(400).json({ error: "The security code is expired or has already been used." });
    if (hashToken(String(code || "")) !== account.code_hash) return res.status(400).json({ error: "Invalid security code." });
    await db.execute({ sql: `UPDATE admin_sub_accounts SET code_used_at = CURRENT_TIMESTAMP WHERE id = 'primary'` });
    const token = crypto.randomBytes(32).toString("hex");
    await db.execute({ sql: `UPDATE admin_sub_accounts SET session_token_hash = ?, session_expires_at = ? WHERE id = 'primary'`, args: [hashToken(token), new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()] });
    res.json({ session_token: token, requires_code: false });
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

app.post("/api/admin/priority-plans", requireAdminKey, async (req, res) => {
  try {
    const { name, duration_hours, price_kes } = req.body;
    const duration = Number(duration_hours);
    const price = Number(price_kes);
    if (!String(name || "").trim() || !Number.isInteger(duration) || duration < 1 || !Number.isInteger(price) || price < 1) {
      return res.status(400).json({ error: "Enter a plan name, duration in hours, and price greater than zero." });
    }
    await db.execute({
      sql: `INSERT INTO priority_plans (id, name, duration_hours, price_kes) VALUES (?, ?, ?, ?)`,
      args: [crypto.randomUUID(), String(name).trim(), duration, price],
    });
    res.status(201).json({ message: "Priority plan created." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/admin/priority-plans/:id", requireAdminKey, async (req, res) => {
  try {
    const { name, duration_hours, price_kes, active = true } = req.body;
    const duration = Number(duration_hours);
    const price = Number(price_kes);
    if (!String(name || "").trim() || !Number.isInteger(duration) || duration < 1 || !Number.isInteger(price) || price < 1) {
      return res.status(400).json({ error: "Enter a plan name, duration in hours, and price greater than zero." });
    }
    const result = await db.execute({
      sql: `UPDATE priority_plans SET name = ?, duration_hours = ?, price_kes = ?, active = ? WHERE id = ?`,
      args: [String(name).trim(), duration, price, active ? 1 : 0, req.params.id],
    });
    if (Number(result.rowsAffected || 0) === 0) return res.status(404).json({ error: "Priority plan not found." });
    res.json({ message: "Priority plan updated." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/admin/priority-plans/:id", requireAdminKey, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `DELETE FROM priority_plans WHERE id = ?`,
      args: [req.params.id],
    });
    if (Number(result.rowsAffected || 0) === 0) return res.status(404).json({ error: "Priority plan not found." });
    res.json({ message: "Priority plan deleted." });
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
  app.listen(port, () => {
    console.log(`Wariara Cars Central Rift API running on http://localhost:${port}`);
  });

  ensureDbReady().catch((err) => {
    console.error("Database initialization unavailable:", err.message);
  });
}

export default app;
