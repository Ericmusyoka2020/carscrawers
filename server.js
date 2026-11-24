


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
const PORT = process.env.PORT || 3000;

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || "";
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY || "";
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || "";
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || "";
const FIREBASE_CONFIG = {
  apiKey: process.env.FIREBASE_API_KEY || "AIzaSyBea-tl8m56bKlw1dprDd6awM6xFqjeKRI",
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || "studio-324556329-8e72a.firebaseapp.com",
  projectId: process.env.FIREBASE_PROJECT_ID || "studio-324556329-8e72a",
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "studio-324556329-8e72a.firebasestorage.app",
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "779859744868",
  appId: process.env.FIREBASE_APP_ID || "1:779859744868:web:a317e563620c70f456e771",
};
const FIREBASE_SIGNING_KEYS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let firebaseSigningKeys = null;
let firebaseSigningKeysExpiresAt = 0;

if (!TURSO_DATABASE_URL) {
  console.error("Missing TURSO_DATABASE_URL environment variable.");
  process.exit(1);
}

const db = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN,
});

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({ firebase: FIREBASE_CONFIG });
});

function rowToObj(result, idx = 0) {
  if (!result || !result.rows || !result.rows[idx]) return null;
  const cols = result.columns;
  const row = result.rows[idx];
  const obj = {};
  cols.forEach((col, i) => {
    obj[col] = row[i];
  });
  return obj;
}

function rowsToArray(result) {
  if (!result || !result.rows || result.rows.length === 0) return [];
  const cols = result.columns;
  return result.rows.map((row) => {
    const obj = {};
    cols.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

async function initDb() {
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        whatsapp_phone TEXT NOT NULL,
        call_phone TEXT NOT NULL,
        role TEXT DEFAULT 'private',
        town TEXT DEFAULT 'Nakuru',
        shop_slug TEXT,
        free_posts_used INTEGER DEFAULT 0,
        paid_post_credits INTEGER DEFAULT 0,
        total_purchased_posts INTEGER DEFAULT 0,
        total_spent_kes INTEGER DEFAULT 0,
        is_suspended INTEGER DEFAULT 0,
        suspension_reason TEXT,
        appeal_text TEXT,
        appeal_status TEXT,
        terms_accepted_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER DEFAULT 0,
        used_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS vehicle_catalog (
        id TEXT PRIMARY KEY,
        vehicle_type TEXT NOT NULL,
        brand TEXT NOT NULL,
        model TEXT NOT NULL,
        body_type TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS post_plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        post_count INTEGER NOT NULL,
        price_kes INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY,
        seller_id TEXT NOT NULL,
        seller_name TEXT NOT NULL,
        seller_slug TEXT,
        whatsapp_phone TEXT,
        call_phone TEXT,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        vehicle_type TEXT,
        condition_type TEXT,
        brand TEXT,
        model TEXT,
        body_type TEXT,
        year INTEGER,
        reg_number TEXT,
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
        price_kes INTEGER NOT NULL,
        negotiable TEXT DEFAULT 'Yes',
        town TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT DEFAULT 'pending_approval'
          CHECK (status IN ('pending_approval', 'active', 'paused', 'reported_suspended', 'unsafe_removed', 'sold', 'rejected', 'expired')),
        rejection_reason TEXT,
        is_paid_post INTEGER DEFAULT 0,
        published_at TEXT,
        priority_amount_kes INTEGER DEFAULT 0,
        priority_date TEXT,
        report_reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS listing_photos (
        id TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL,
        photo_data TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS seller_notifications (
        id TEXT PRIMARY KEY,
        seller_id TEXT NOT NULL,
        user_id TEXT,
        message TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS payment_notifications (
        id TEXT PRIMARY KEY,
        seller_id TEXT,
        payer_name TEXT,
        payer_phone TEXT,
        payer_email TEXT,
        purpose TEXT NOT NULL,
        amount_kes INTEGER DEFAULT 0,
        payment_ref TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS sub_admins (
        slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 4),
        pin_hash TEXT NOT NULL,
        email TEXT,
        email_code_enabled INTEGER NOT NULL DEFAULT 0,
        code_hash TEXT,
        code_expires_at TEXT,
        code_failed_attempts INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS sub_admin_sessions (
        token_hash TEXT PRIMARY KEY,
        slot INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS sub_admin_login_limits (
        ip_hash TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT
      )`,
    ],
    "write"
  );

  const userColumns = await db.execute("PRAGMA table_info(users)");
  const existingUserColumns = new Set(userColumns.rows.map((row) => row.name));
  const userColumnMigrations = [
    ["role", "TEXT DEFAULT 'private'"],
    ["town", "TEXT DEFAULT 'Nakuru'"],
    ["shop_slug", "TEXT"],
    ["free_posts_used", "INTEGER DEFAULT 0"],
    ["paid_post_credits", "INTEGER DEFAULT 0"],
    ["total_purchased_posts", "INTEGER DEFAULT 0"],
    ["total_spent_kes", "INTEGER DEFAULT 0"],
    ["is_suspended", "INTEGER DEFAULT 0"],
    ["suspension_reason", "TEXT"],
    ["appeal_text", "TEXT"],
    ["appeal_status", "TEXT"],
    ["terms_accepted_at", "TEXT"],
    ["created_at", "TEXT"],
  ];
  for (const [column, definition] of userColumnMigrations) {
    if (!existingUserColumns.has(column)) {
      await db.execute(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
    }
  }

  const listingColumns = await db.execute("PRAGMA table_info(listings)");
  const existingListingColumns = new Set(listingColumns.rows.map((row) => row.name));
  const listingColumnMigrations = [
    ["seller_name", "TEXT"],
    ["seller_slug", "TEXT"],
    ["updated_at", "TEXT"],
    ["rejection_reason", "TEXT"],
  ];
  for (const [column, definition] of listingColumnMigrations) {
    if (!existingListingColumns.has(column)) {
      await db.execute(`ALTER TABLE listings ADD COLUMN ${column} ${definition}`);
    }
  }
  const listingsSchemaRes = await db.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'listings'"
  );
  const listingsSchema = String(rowToObj(listingsSchemaRes)?.sql || "");
  const statusCheck = listingsSchema.match(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i);
  if (
    statusCheck &&
    (!/'rejected'/i.test(statusCheck[1]) || !/'expired'/i.test(statusCheck[1]))
  ) {
    await db.batch(
      [
        `CREATE TABLE listings_migrated (
          id TEXT PRIMARY KEY,
          seller_id TEXT NOT NULL,
          seller_name TEXT,
          seller_slug TEXT,
          whatsapp_phone TEXT,
          call_phone TEXT,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          vehicle_type TEXT,
          condition_type TEXT,
          brand TEXT,
          model TEXT,
          body_type TEXT,
          year INTEGER,
          reg_number TEXT,
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
          price_kes INTEGER NOT NULL,
          negotiable TEXT DEFAULT 'Yes',
          town TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT DEFAULT 'pending_approval'
            CHECK (status IN ('pending_approval', 'active', 'paused', 'reported_suspended', 'unsafe_removed', 'sold', 'rejected', 'expired')),
          rejection_reason TEXT,
          is_paid_post INTEGER DEFAULT 0,
          published_at TEXT,
          priority_amount_kes INTEGER DEFAULT 0,
          priority_date TEXT,
          report_reason TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `INSERT INTO listings_migrated (
          id, seller_id, seller_name, seller_slug, whatsapp_phone, call_phone, category, title,
          vehicle_type, condition_type, brand, model, body_type, year, reg_number, fuel_type,
          transmission, drive_type, air_con, engine_cc, mileage_km, part_name, part_make,
          part_model, year_from, year_to, part_condition, part_authenticity, price_kes, negotiable,
          town, description, status, rejection_reason, is_paid_post, published_at,
          priority_amount_kes, priority_date, report_reason, created_at, updated_at
        )
        SELECT
          id, seller_id, seller_name, seller_slug, whatsapp_phone, call_phone, category, title,
          vehicle_type, condition_type, brand, model, body_type, year, reg_number, fuel_type,
          transmission, drive_type, air_con, engine_cc, mileage_km, part_name, part_make,
          part_model, year_from, year_to, part_condition, part_authenticity, price_kes, negotiable,
          town, description, status, rejection_reason, is_paid_post, published_at,
          priority_amount_kes, priority_date, report_reason, created_at, updated_at
        FROM listings`,
        "DROP TABLE listings",
        "ALTER TABLE listings_migrated RENAME TO listings",
      ],
      "write"
    );
  }
  const notificationColumns = await db.execute("PRAGMA table_info(seller_notifications)");
  const existingNotificationColumns = new Set(notificationColumns.rows.map((row) => row.name));
  for (const column of ["seller_id", "user_id"]) {
    if (!existingNotificationColumns.has(column)) {
      await db.execute(`ALTER TABLE seller_notifications ADD COLUMN ${column} TEXT`);
    }
  }
  await db.execute(`
    UPDATE seller_notifications
    SET seller_id = COALESCE(seller_id, user_id),
        user_id = COALESCE(user_id, seller_id)
    WHERE seller_id IS NULL OR user_id IS NULL
  `);
  const paymentColumns = await db.execute("PRAGMA table_info(payment_notifications)");
  const existingPaymentColumns = new Set(paymentColumns.rows.map((row) => row.name));
  const paymentColumnMigrations = [
    ["id", "TEXT"],
    ["seller_id", "TEXT"],
    ["payer_name", "TEXT"],
    ["payer_phone", "TEXT"],
    ["payer_email", "TEXT"],
    ["purpose", "TEXT NOT NULL DEFAULT 'Payment'"],
    ["amount_kes", "INTEGER DEFAULT 0"],
    ["payment_ref", "TEXT"],
    ["created_at", "TEXT"],
  ];
  for (const [column, definition] of paymentColumnMigrations) {
    if (!existingPaymentColumns.has(column)) {
      await db.execute(`ALTER TABLE payment_notifications ADD COLUMN ${column} ${definition}`);
    }
  }
  await db.execute(`
    UPDATE listings
    SET seller_name = COALESCE(
      NULLIF(seller_name, ''),
      (SELECT name FROM users WHERE users.id = listings.seller_id)
    ),
    seller_slug = COALESCE(
      NULLIF(seller_slug, ''),
      (SELECT shop_slug FROM users WHERE users.id = listings.seller_id)
    ),
    updated_at = COALESCE(updated_at, created_at)
    WHERE seller_name IS NULL
       OR seller_name = ''
       OR seller_slug IS NULL
       OR seller_slug = ''
       OR updated_at IS NULL
  `);

  const settingsCount = await db.execute("SELECT COUNT(*) AS cnt FROM platform_settings");
  if (Number(settingsCount.rows[0]?.[0] || 0) === 0) {
    await db.execute({
      sql: "INSERT INTO platform_settings (key, value) VALUES (?, ?)",
      args: ["base_priority_price_kes", "300"],
    });
  }

  const plansCount = await db.execute("SELECT COUNT(*) AS cnt FROM post_plans");
  if (Number(plansCount.rows[0]?.[0] || 0) === 0) {
    await db.batch(
      [
        {
          sql: "INSERT INTO post_plans (id, name, post_count, price_kes) VALUES (?, ?, ?, ?)",
          args: ["plan-starter", "Starter Pack", 10, 200],
        },
        {
          sql: "INSERT INTO post_plans (id, name, post_count, price_kes) VALUES (?, ?, ?, ?)",
          args: ["plan-pro", "Dealer Pack", 25, 500],
        },
      ],
      "write"
    );
  }

  const catalogCount = await db.execute("SELECT COUNT(*) AS cnt FROM vehicle_catalog");
  if (Number(catalogCount.rows[0]?.[0] || 0) === 0) {
    const defaults = [
      ["cat-1", "Car", "Toyota", "Fielder", "Station Wagon"],
      ["cat-2", "Car", "Toyota", "Harrier", "SUV"],
      ["cat-3", "Car", "Toyota", "Prado", "SUV"],
      ["cat-4", "Car", "Mazda", "Demio", "Hatchback"],
      ["cat-5", "Car", "Subaru", "Forester", "SUV"],
      ["cat-6", "Car", "Volkswagen", "Golf", "Hatchback"],
      ["cat-7", "Truck", "Isuzu", "FRR", "Lorry"],
      ["cat-8", "Bike", "Honda", "XR150L", "Motorcycle"],
    ];
    for (const d of defaults) {
      await db.execute({
        sql: "INSERT OR IGNORE INTO vehicle_catalog (id, vehicle_type, brand, model, body_type) VALUES (?, ?, ?, ?, ?)",
        args: d,
      });
    }
  }
}

function isTransientDatabaseError(error) {
  const code = error?.cause?.code || error?.code;
  return [
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
  ].includes(code) || (error instanceof TypeError && /fetch failed/i.test(error.message));
}

async function initializeDatabaseWithRetry() {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initDb();
      return;
    } catch (error) {
      if (!isTransientDatabaseError(error) || attempt === maxAttempts) throw error;
      const delayMs = attempt * 1000;
      console.warn(`Turso connection failed during startup; retrying in ${delayMs / 1000}s (${attempt + 1}/${maxAttempts}).`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function requireAdmin(req, res, next) {
  const key = req.get("x-admin-key");
  if (key && ADMIN_SECRET && key === ADMIN_SECRET) {
    req.adminRole = "owner";
    return next();
  }
  if (typeof key !== "string" || !key) {
    return res.status(401).json({ error: "Unauthorized: invalid admin session." });
  }
  try {
    const tokenHash = crypto.createHash("sha256").update(key).digest("hex");
    const sessionRes = await db.execute({
      sql: "SELECT slot FROM sub_admin_sessions WHERE token_hash = ? AND expires_at > ?",
      args: [tokenHash, new Date().toISOString()],
    });
    const session = rowToObj(sessionRes);
    if (!session) return res.status(401).json({ error: "Sub-admin session expired. Please sign in again." });
    req.adminRole = "subadmin";
    req.subAdminSlot = Number(session.slot);
    next();
  } catch (error) {
    next(error);
  }
}

function requireOwnerAdmin(req, res, next) {
  if (!ADMIN_SECRET || req.get("x-admin-key") !== ADMIN_SECRET) {
    return res.status(403).json({ error: "Only the primary admin can manage sub-admin PINs." });
  }
  req.adminRole = "owner";
  next();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

async function getFirebaseSigningKeys() {
  if (firebaseSigningKeys && firebaseSigningKeysExpiresAt > Date.now()) return firebaseSigningKeys;

  let response;
  try {
    response = await fetch(FIREBASE_SIGNING_KEYS_URL, { signal: AbortSignal.timeout(10000) });
  } catch {
    const error = new Error("Firebase token verification is temporarily unavailable.");
    error.status = 503;
    throw error;
  }
  if (!response.ok) {
    const error = new Error("Firebase token verification is temporarily unavailable.");
    error.status = 503;
    throw error;
  }
  const data = await response.json();
  if (!Array.isArray(data.keys)) throw new Error("Firebase signing keys response was invalid.");

  const cacheControl = response.headers.get("cache-control") || "";
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/i)?.[1] || 3600);
  firebaseSigningKeys = data.keys;
  firebaseSigningKeysExpiresAt = Date.now() + Math.max(60, maxAge) * 1000;
  return firebaseSigningKeys;
}

async function verifyFirebaseIdToken(idToken) {
  const invalidToken = () => {
    const error = new Error("A valid Firebase sign-in is required.");
    error.status = 401;
    return error;
  };
  if (typeof idToken !== "string") throw invalidToken();

  const parts = idToken.split(".");
  if (parts.length !== 3) throw invalidToken();

  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw invalidToken();
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw invalidToken();

  let keys = await getFirebaseSigningKeys();
  let signingKey = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!signingKey) {
    firebaseSigningKeysExpiresAt = 0;
    keys = await getFirebaseSigningKeys();
    signingKey = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  }
  if (!signingKey) throw invalidToken();

  let signatureIsValid = false;
  try {
    signatureIsValid = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      crypto.createPublicKey({ key: signingKey, format: "jwk" }),
      Buffer.from(parts[2], "base64url"),
    );
  } catch {
    throw invalidToken();
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    !signatureIsValid ||
    claims.aud !== FIREBASE_CONFIG.projectId ||
    claims.iss !== `https://securetoken.google.com/${FIREBASE_CONFIG.projectId}` ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    typeof claims.email !== "string" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60 ||
    !Number.isFinite(claims.auth_time) ||
    claims.auth_time > now + 60
  ) {
    throw invalidToken();
  }
  return claims;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, keyHex] = stored.split(":");
  const derived = crypto.scryptSync(String(password), salt, 64);
  const keyBuf = Buffer.from(keyHex, "hex");
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

function hashSubAdminPin(pin) {
  return hashPassword(pin);
}

function hashSubAdminCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function maskEmail(email) {
  const [name, domain] = String(email || "").split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, 1)}${"*".repeat(Math.max(2, name.length - 1))}@${domain}`;
}

async function sendSubAdminCode(email, code) {
  if (!EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY || !EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID) {
    const error = new Error("Email verification is not configured. Set the EmailJS service, template, public, and private keys on the API server.");
    error.status = 503;
    throw error;
  }
  const appName = "Wariara Cars Central Rift Admin";
  const message = `Your ${appName} verification code is ${code}. It expires in 10 minutes.`;
  let response;
  try {
    response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: EMAILJS_PRIVATE_KEY,
        template_params: {
          to_email: email,
          recipient_email: email,
          user_email: email,
          to_name: email,
          email,
          subject: `${appName} verification code`,
          email_subject: `${appName} verification code`,
          message,
          content: message,
          verification_message: message,
          code_message: message,
          passcode: code,
          verification_code: code,
          verificationCode: code,
          otp_code: code,
          code,
          otp: code,
          app_name: appName,
          expires_in: "10 minutes",
        },
      }),
    });
  } catch (cause) {
    const error = new Error("Could not send the verification email. Please try again.");
    error.status = 502;
    error.cause = cause;
    throw error;
  }
  if (!response.ok) {
    console.error(`EmailJS rejected a sub-admin verification email (HTTP ${response.status}).`);
    const error = new Error("EmailJS could not send the verification email. Check the EmailJS service and template configuration.");
    error.status = 502;
    throw error;
  }
}

function slugify(str) {
  return (
    String(str || "seller")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || `seller-${Date.now()}`
  );
}

function todayKenyaDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
}

function computeDaysRemaining(listing) {
  if (!Number(listing.is_paid_post)) return null;
  const baseDate = listing.published_at || listing.created_at;
  if (!baseDate) return 70;
  const elapsedMs = Date.now() - new Date(baseDate).getTime();
  const elapsedDays = Math.floor(elapsedMs / (1000 * 60 * 60 * 24));
  return Math.max(0, 70 - elapsedDays);
}

async function syncExpiredListings() {
  const res = await db.execute(
    "SELECT id, created_at, published_at, is_paid_post, status FROM listings WHERE is_paid_post = 1 AND status = 'active'"
  );
  const paidActive = rowsToArray(res);
  if (paidActive.length === 0) return;

  const expiredIds = paidActive
    .filter((l) => computeDaysRemaining(l) === 0)
    .map((l) => l.id);

  const nowIso = new Date().toISOString();
  for (const id of expiredIds) {
    await db.execute({
      sql: "UPDATE listings SET status = 'expired', updated_at = ? WHERE id = ?",
      args: [nowIso, id],
    });
  }
}

async function addSellerNotification(sellerId, message) {
  if (!sellerId || !message) return;
  await db.execute({
    sql: "INSERT INTO seller_notifications (id, seller_id, user_id, message, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), sellerId, sellerId, message, new Date().toISOString()],
  });
}

async function addPaymentNotification({ sellerId, payerName, payerPhone, payerEmail, purpose, amountKes, paymentRef }) {
  await db.execute({
    sql: `INSERT INTO payment_notifications
      (id, seller_id, payer_name, payer_phone, payer_email, purpose, amount_kes, payment_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      sellerId || null,
      payerName || "Seller",
      payerPhone || "",
      payerEmail || "",
      purpose,
      Number(amountKes || 0),
      paymentRef || "",
      new Date().toISOString(),
    ],
  });
}

function validateAllPostFieldsRequired(payload) {
  if (!["motor", "part"].includes(payload.category)) return "Select a valid post category.";
  if (!String(payload.description || "").trim()) return "Description is required.";
  if (payload.photos !== undefined && (!Array.isArray(payload.photos) || payload.photos.length > 6)) {
    return "Please provide no more than 6 photos.";
  }
  return null;
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

function buildListingTitle(payload) {
  if (payload.category === "motor") {
    return [
      optionalNumber(payload.year),
      optionalText(payload.brand),
      optionalText(payload.model),
    ].filter(Boolean).join(" ") || String(payload.description).trim().slice(0, 80);
  }
  const partName = optionalText(payload.part_name);
  const vehicle = [optionalText(payload.part_make), optionalText(payload.part_model)].filter(Boolean).join(" ");
  return (partName && vehicle ? `${partName} (${vehicle})` : partName || vehicle) ||
    String(payload.description).trim().slice(0, 80);
}

function sanitizeUser(u) {
  if (!u) return null;
  const copy = { ...u };
  delete copy.password_hash;
  copy.is_suspended = Boolean(copy.is_suspended);
  return copy;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Wariara Cars Central Rift API (Turso)",
    emailjsConfigured: Boolean(
      EMAILJS_PUBLIC_KEY && EMAILJS_PRIVATE_KEY && EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID
    ),
  });
});

// ================= PUBLIC META & DEALERS =================

app.get("/api/meta", async (req, res) => {
  try {
    const [catalogRes, plansRes, settingsRes] = await Promise.all([
      db.execute("SELECT * FROM vehicle_catalog ORDER BY brand ASC"),
      db.execute("SELECT * FROM post_plans ORDER BY price_kes ASC"),
      db.execute("SELECT * FROM platform_settings"),
    ]);

    const settings = {};
    for (const r of rowsToArray(settingsRes)) {
      settings[r.key] = r.value;
    }

    res.json({
      catalog: rowsToArray(catalogRes),
      plans: rowsToArray(plansRes),
      settings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/dealers", async (req, res) => {
  try {
    const [usersRes, listingsRes] = await Promise.all([
      db.execute("SELECT id, name, town, role, shop_slug, whatsapp_phone, call_phone, is_suspended FROM users WHERE role = 'dealer'"),
      db.execute("SELECT seller_id, status FROM listings WHERE status = 'active'"),
    ]);

    const activeCountBySeller = {};
    for (const l of rowsToArray(listingsRes)) {
      activeCountBySeller[l.seller_id] = (activeCountBySeller[l.seller_id] || 0) + 1;
    }

    const dealers = rowsToArray(usersRes)
      .filter((u) => !Number(u.is_suspended))
      .map((u) => ({
        id: u.id,
        name: u.name,
        town: u.town,
        role: u.role,
        shop_slug: u.shop_slug || slugify(u.name),
        whatsapp_phone: u.whatsapp_phone,
        call_phone: u.call_phone,
        active_listings: activeCountBySeller[u.id] || 0,
      }));

    res.json({ dealers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= SELLER ACCOUNTS & AUTH =================

app.post("/api/sellers/account", async (req, res) => {
  try {
    const {
      name,
      email,
      firebase_id_token,
      whatsapp_phone,
      call_phone,
      role = "private",
      town = "Nakuru",
      accepted_terms,
    } = req.body;

    if (!name || !email || !whatsapp_phone || !call_phone || !firebase_id_token) {
      return res.status(400).json({ error: "Name, email, WhatsApp, call phone, and Firebase sign-in are required." });
    }
    if (accepted_terms !== true && accepted_terms !== "true") {
      return res.status(400).json({ error: "You must accept the Terms and Conditions to create an account." });
    }

    const firebaseUser = await verifyFirebaseIdToken(firebase_id_token);
    const cleanEmail = firebaseUser.email.trim().toLowerCase();
    if (String(email).trim().toLowerCase() !== cleanEmail) {
      return res.status(403).json({ error: "The signed-in Firebase email does not match the seller profile." });
    }
    const existingRes = await db.execute({
      sql: "SELECT * FROM users WHERE email = ?",
      args: [cleanEmail],
    });
    const existingUser = rowToObj(existingRes);
    if (existingUser) return res.json({ user: sanitizeUser(existingUser) });

    const id = crypto.randomUUID();
    const cleanRole = role === "dealer" ? "dealer" : "private";
    const cleanTown = String(town).trim() || "Nakuru";
    const shopSlug = slugify(name);
    const nowIso = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO users
        (id, name, email, password_hash, whatsapp_phone, call_phone, role, town, shop_slug,
         free_posts_used, paid_post_credits, total_purchased_posts, total_spent_kes, is_suspended, terms_accepted_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?)`,
      args: [
        id,
        String(name).trim(),
        cleanEmail,
        hashPassword(crypto.randomBytes(32).toString("hex")),
        String(whatsapp_phone).trim(),
        String(call_phone).trim(),
        cleanRole,
        cleanTown,
        shopSlug,
        nowIso,
        nowIso,
      ],
    });

    const createdRes = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] });
    res.json({ user: sanitizeUser(rowToObj(createdRes)) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/sellers/login", async (req, res) => {
  try {
    const { firebase_id_token } = req.body;
    if (!firebase_id_token) return res.status(400).json({ error: "Firebase sign-in is required." });

    const firebaseUser = await verifyFirebaseIdToken(firebase_id_token);
    const cleanEmail = firebaseUser.email.trim().toLowerCase();
    const userRes = await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [cleanEmail] });
    const user = rowToObj(userRes);

    if (!user) return res.status(404).json({ error: "Seller profile not found. Complete the sign-up form." });

    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/sellers/forgot-password/token", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });

    const cleanEmail = String(email).trim().toLowerCase();
    const userRes = await db.execute({
      sql: "SELECT id, name, email FROM users WHERE email = ?",
      args: [cleanEmail],
    });
    const user = rowToObj(userRes);

    if (!user) {
      return res.status(404).json({ error: "No seller account found with that email." });
    }

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60).toISOString();

    await db.execute({
      sql: "INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)",
      args: [crypto.randomUUID(), user.id, token, expiresAt, new Date().toISOString()],
    });

    res.json({ token, email: user.email, name: user.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sellers/reset-password", async (req, res) => {
  try {
    const { token, password, confirm_password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: "Reset token and new password are required." });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    if (confirm_password !== undefined && password !== confirm_password) {
      return res.status(400).json({ error: "New passwords do not match." });
    }

    const tokenRes = await db.execute({
      sql: "SELECT * FROM password_reset_tokens WHERE token = ?",
      args: [String(token).trim()],
    });
    const resetRow = rowToObj(tokenRes);

    if (!resetRow || Number(resetRow.used)) {
      return res.status(400).json({ error: "This reset link is invalid or has already been used." });
    }
    if (new Date(resetRow.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "This reset link has expired." });
    }

    await db.execute({
      sql: "UPDATE users SET password_hash = ? WHERE id = ?",
      args: [hashPassword(password), resetRow.user_id],
    });
    await db.execute({
      sql: "UPDATE password_reset_tokens SET used = 1, used_at = ? WHERE id = ?",
      args: [new Date().toISOString(), resetRow.id],
    });

    const updatedUserRes = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [resetRow.user_id] });

    res.json({
      message: "Password updated successfully. This one-time link is now expired.",
      user: sanitizeUser(rowToObj(updatedUserRes)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sellers/lookup", async (req, res) => {
  try {
    const { seller_id } = req.query;
    if (!seller_id) return res.status(400).json({ error: "seller_id is required." });

    const userRes = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [seller_id] });
    const user = rowToObj(userRes);
    if (!user) return res.status(404).json({ error: "Seller not found." });

    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getActiveSeller(sellerId, res) {
  const userRes = await db.execute({
    sql: "SELECT * FROM users WHERE id = ?",
    args: [sellerId],
  });
  const user = rowToObj(userRes);
  if (!user) {
    res.status(404).json({ error: "Seller account not found." });
    return null;
  }
  if (Number(user.is_suspended)) {
    res.status(403).json({ error: "Your seller account is suspended. You can only request a review." });
    return null;
  }
  return user;
}

app.get("/api/sellers/:id/notifications", async (req, res) => {
  try {
    const [notifRes, paymentsRes] = await Promise.all([
      db.execute({
        sql: "SELECT * FROM seller_notifications WHERE seller_id = ? ORDER BY created_at DESC LIMIT 50",
        args: [req.params.id],
      }),
      db.execute({
        sql: `SELECT id, purpose, amount_kes, created_at
          FROM payment_notifications WHERE seller_id = ? ORDER BY created_at DESC LIMIT 50`,
        args: [req.params.id],
      }),
    ]);
    res.json({
      notifications: rowsToArray(notifRes),
      paymentNotifications: rowsToArray(paymentsRes),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sellers/:id/listings", async (req, res) => {
  try {
    await syncExpiredListings();
    const listRes = await db.execute({
      sql: "SELECT * FROM listings WHERE seller_id = ? ORDER BY created_at DESC",
      args: [req.params.id],
    });
    const enriched = rowsToArray(listRes).map((l) => ({
      ...l,
      days_remaining: computeDaysRemaining(l),
    }));
    res.json({ listings: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sellers/:id/appeal", async (req, res) => {
  try {
    const { appeal_text } = req.body;
    const message = String(appeal_text || "").trim();
    if (!message) {
      return res.status(400).json({ error: "Please enter a review message." });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: "Review message must be 2,000 characters or fewer." });
    }
    const userRes = await db.execute({
      sql: "SELECT id, is_suspended FROM users WHERE id = ?",
      args: [req.params.id],
    });
    const user = rowToObj(userRes);
    if (!user) return res.status(404).json({ error: "Seller account not found." });
    if (!Number(user.is_suspended)) {
      return res.status(409).json({ error: "A review request is only available while your account is suspended." });
    }
    await db.execute({
      sql: "UPDATE users SET appeal_text = ?, appeal_status = 'pending' WHERE id = ?",
      args: [message, req.params.id],
    });
    res.json({ message: "Review request sent to Admin." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= PLANS & LISTINGS =================

app.post("/api/plans/purchase", async (req, res) => {
  try {
    const { seller_id, plan_id, payment_ref = "", payer_phone = "" } = req.body;
    if (!seller_id || !plan_id) {
      return res.status(400).json({ error: "seller_id and plan_id are required." });
    }

    const [userRes, planRes] = await Promise.all([
      db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [seller_id] }),
      db.execute({ sql: "SELECT * FROM post_plans WHERE id = ?", args: [plan_id] }),
    ]);
    const user = rowToObj(userRes);
    const plan = rowToObj(planRes);

    if (!user || !plan) {
      return res.status(404).json({ error: "Seller or plan not found." });
    }
    if (Number(user.is_suspended)) {
      return res.status(403).json({ error: "Your seller account is suspended. You can only request a review." });
    }

    const newCredits = Number(user.paid_post_credits || 0) + Number(plan.post_count || 0);
    const newTotalPurchased = Number(user.total_purchased_posts || 0) + Number(plan.post_count || 0);
    const newTotalSpent = Number(user.total_spent_kes || 0) + Number(plan.price_kes || 0);

    await db.execute({
      sql: "UPDATE users SET paid_post_credits = ?, total_purchased_posts = ?, total_spent_kes = ? WHERE id = ?",
      args: [newCredits, newTotalPurchased, newTotalSpent, user.id],
    });

    await addSellerNotification(
      user.id,
      `Purchased plan "${plan.name}" (+${plan.post_count} post credits for KES ${plan.price_kes}). Paid posts run for 70 days once published.`
    );

    await addPaymentNotification({
      sellerId: user.id,
      payerName: user.name,
      payerPhone: payer_phone || user.whatsapp_phone,
      payerEmail: user.email,
      purpose: `Post Plan: ${plan.name} (+${plan.post_count} posts, 70d lifetime)`,
      amountKes: plan.price_kes,
      paymentRef,
    });

    const updatedRes = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [user.id] });

    res.json({
      message: `Added ${plan.post_count} post credits to your account.`,
      user: sanitizeUser(rowToObj(updatedRes)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/listings", async (req, res) => {
  try {
    await syncExpiredListings();

    const {
      category = "motor",
      q = "",
      seller = "",
      town = "",
      brand = "",
      model = "",
      min_price = "",
      max_price = "",
      vehicle_type = "",
      body_type = "",
      condition_type = "",
      fuel_type = "",
      transmission = "",
      drive_type = "",
      air_con = "",
      min_year = "",
      part_authenticity = "",
      seller_slug = "",
      exclude_seller_id = "",
      sort = "featured",
      limit = "",
    } = req.query;

    const listRes = await db.execute({
      sql: "SELECT * FROM listings WHERE status = 'active' AND category = ?",
      args: [category],
    });
    let items = rowsToArray(listRes);

    if (q) {
      const needle = String(q).toLowerCase().trim();
      items = items.filter((x) =>
        [
          x.title, x.brand, x.model, x.body_type, x.part_name,
          x.part_make, x.part_model, x.description, x.town, x.seller_name
        ].some((v) => String(v || "").toLowerCase().includes(needle))
      );
    }
    if (seller) {
      const sellerNeedle = String(seller).toLowerCase().trim();
      items = items.filter((x) =>
        [x.seller_name, x.seller_slug].some((v) => String(v || "").toLowerCase().includes(sellerNeedle))
      );
    }
    if (town) items = items.filter((x) => String(x.town || "").toLowerCase() === String(town).toLowerCase());
    if (brand) items = items.filter((x) => String(x.brand || "").toLowerCase() === String(brand).toLowerCase());
    if (model) items = items.filter((x) => String(x.model || "").toLowerCase() === String(model).toLowerCase());
    if (min_price) items = items.filter((x) => Number(x.price_kes) >= Number(min_price));
    if (max_price) items = items.filter((x) => Number(x.price_kes) <= Number(max_price));
    if (vehicle_type) items = items.filter((x) => x.vehicle_type === vehicle_type);
    if (body_type) items = items.filter((x) => String(x.body_type || "").toLowerCase() === String(body_type).toLowerCase());
    if (condition_type) {
      items = items.filter((x) => (x.condition_type || x.part_condition) === condition_type);
    }
    if (fuel_type) items = items.filter((x) => x.fuel_type === fuel_type);
    if (transmission) items = items.filter((x) => x.transmission === transmission);
    if (drive_type) items = items.filter((x) => x.drive_type === drive_type);
    if (air_con) items = items.filter((x) => x.air_con === air_con);
    if (min_year) {
      items = items.filter((x) => Number(x.year || x.year_from || 0) >= Number(min_year));
    }
    if (part_authenticity) items = items.filter((x) => x.part_authenticity === part_authenticity);
    if (seller_slug) items = items.filter((x) => x.seller_slug === seller_slug);
    if (exclude_seller_id) items = items.filter((x) => x.seller_id !== String(exclude_seller_id));

    const todayStr = todayKenyaDate();
    items = items.map((x) => {
      const isSponsoredToday =
        String(x.priority_date || "").slice(0, 10) === todayStr &&
        Number(x.priority_amount_kes || 0) > 0;
      return { ...x, is_sponsored: isSponsoredToday };
    });

    if (sort === "price_asc") {
      items.sort((a, b) => Number(a.price_kes) - Number(b.price_kes));
    } else if (sort === "price_desc") {
      items.sort((a, b) => Number(b.price_kes) - Number(a.price_kes));
    } else if (sort === "mileage_asc") {
      items.sort((a, b) => Number(a.mileage_km || 999999999) - Number(b.mileage_km || 999999999));
    } else if (sort === "year_desc") {
      items.sort((a, b) => Number(b.year || b.year_to || 0) - Number(a.year || a.year_to || 0));
    } else if (sort === "newest") {
      items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } else {
      const sponsored = items
        .filter((x) => x.is_sponsored)
        .sort((a, b) => Number(b.priority_amount_kes) - Number(a.priority_amount_kes))
        .slice(0, 20);
      const sponsoredIds = new Set(sponsored.map((x) => x.id));
      const rest = items
        .filter((x) => !sponsoredIds.has(x.id))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      items = [...sponsored, ...rest];
    }

    if (limit) {
      const requestedLimit = Number(limit);
      if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
        items = items.slice(0, Math.min(50, Math.floor(requestedLimit)));
      }
    }

    const ids = items.map((x) => x.id);
    const coverMap = {};
    const countMap = {};

    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const photosRes = await db.execute({
        sql: `SELECT listing_id, photo_data, sort_order FROM listing_photos WHERE listing_id IN (${placeholders}) ORDER BY sort_order ASC`,
        args: ids,
      });
      for (const p of rowsToArray(photosRes)) {
        countMap[p.listing_id] = (countMap[p.listing_id] || 0) + 1;
        if (!coverMap[p.listing_id]) {
          coverMap[p.listing_id] = p.photo_data;
        }
      }
    }

    const enriched = items.map((x) => ({
      ...x,
      cover_photo: coverMap[x.id] || "",
      photo_count: countMap[x.id] || 0,
      days_remaining: computeDaysRemaining(x),
    }));

    res.json({ listings: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/listings/:id", async (req, res) => {
  try {
    const [listRes, photosRes] = await Promise.all([
      db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [req.params.id] }),
      db.execute({
        sql: "SELECT id, photo_data, sort_order FROM listing_photos WHERE listing_id = ? ORDER BY sort_order ASC",
        args: [req.params.id],
      }),
    ]);

    const listing = rowToObj(listRes);
    if (!listing) return res.status(404).json({ error: "Listing not found." });

    res.json({
      listing: {
        ...listing,
        photos: rowsToArray(photosRes),
        days_remaining: computeDaysRemaining(listing),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/listings/:id/report", async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: "Report reason is required." });
    }

    const info = await db.execute({
      sql: "UPDATE listings SET status = 'reported_suspended', report_reason = ?, updated_at = ? WHERE id = ?",
      args: [String(reason).trim(), new Date().toISOString(), req.params.id],
    });

    if (Number(info.rowsAffected || 0) === 0) {
      return res.status(404).json({ error: "Listing not found." });
    }

    res.json({ message: "Post reported and temporarily suspended for Admin review." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/listings", async (req, res) => {
  try {
    const payload = req.body || {};
    const fieldError = validateAllPostFieldsRequired(payload);
    if (fieldError) return res.status(400).json({ error: fieldError });

    if (!payload.seller_id) {
      return res.status(400).json({ error: "Seller account is required." });
    }

    const userRes = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [payload.seller_id] });
    const user = rowToObj(userRes);

    if (!user) return res.status(404).json({ error: "Seller account not found." });
    if (Number(user.is_suspended)) {
      return res.status(403).json({ error: "Your seller account is suspended." });
    }

    const freeUsed = Number(user.free_posts_used || 0);
    const paidCredits = Number(user.paid_post_credits || 0);

    let usedPaidCredit = false;
    if (freeUsed < 6) {
      await db.execute({
        sql: "UPDATE users SET free_posts_used = ? WHERE id = ?",
        args: [freeUsed + 1, user.id],
      });
    } else if (paidCredits > 0) {
      usedPaidCredit = true;
      await db.execute({
        sql: "UPDATE users SET paid_post_credits = ? WHERE id = ?",
        args: [paidCredits - 1, user.id],
      });
    } else {
      return res.status(402).json({
        error: "You have used all 6 free posts. Purchase a post plan to continue posting.",
        needs_plan: true,
      });
    }

    const id = crypto.randomUUID();
    const title = buildListingTitle(payload);
    const nowIso = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO listings
        (id, seller_id, seller_name, seller_slug, whatsapp_phone, call_phone, category, title,
         vehicle_type, condition_type, brand, model, body_type, year, reg_number, fuel_type,
         transmission, drive_type, air_con, engine_cc, mileage_km,
         part_name, part_make, part_model, year_from, year_to, part_condition, part_authenticity,
         price_kes, negotiable, town, description, status, is_paid_post, published_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, NULL, ?, ?)`,
      args: [
        id,
        user.id,
        user.name,
        user.shop_slug || slugify(user.name),
        user.whatsapp_phone,
        user.call_phone,
        payload.category,
        title,
        payload.category === "motor" ? optionalText(payload.vehicle_type) : null,
        payload.category === "motor" ? optionalText(payload.condition_type) : null,
        payload.category === "motor" ? optionalText(payload.brand) : null,
        payload.category === "motor" ? optionalText(payload.model) : null,
        payload.category === "motor" ? optionalText(payload.body_type) : null,
        payload.category === "motor" ? optionalNumber(payload.year) : null,
        payload.category === "motor" ? optionalText(payload.reg_number) : null,
        payload.category === "motor" ? optionalText(payload.fuel_type) : null,
        payload.category === "motor" ? optionalText(payload.transmission) : null,
        payload.category === "motor" ? optionalText(payload.drive_type) : null,
        payload.category === "motor" ? optionalText(payload.air_con) : null,
        payload.category === "motor" ? optionalNumber(payload.engine_cc) : null,
        payload.category === "motor" ? optionalNumber(payload.mileage_km) : null,
        payload.category === "part" ? optionalText(payload.part_name) : null,
        payload.category === "part" ? optionalText(payload.part_make) : null,
        payload.category === "part" ? optionalText(payload.part_model) : null,
        payload.category === "part" ? optionalNumber(payload.year_from) : null,
        payload.category === "part" ? optionalNumber(payload.year_to) : null,
        payload.category === "part" ? optionalText(payload.part_condition) : null,
        payload.category === "part" ? optionalText(payload.part_authenticity) : null,
        optionalNumber(payload.price_kes) ?? 0,
        optionalText(payload.negotiable) || "Yes",
        optionalText(payload.town) || "Nakuru",
        String(payload.description).trim(),
        usedPaidCredit ? 1 : 0,
        nowIso,
        nowIso,
      ],
    });

    for (let idx = 0; idx < (payload.photos || []).slice(0, 6).length; idx++) {
      await db.execute({
        sql: "INSERT INTO listing_photos (id, listing_id, photo_data, sort_order) VALUES (?, ?, ?, ?)",
        args: [crypto.randomUUID(), id, payload.photos[idx], idx],
      });
    }

    await addSellerNotification(
      user.id,
      usedPaidCredit
        ? `Deducted 1 paid post credit for "${title}" (pending Admin approval; runs for 70 days once published).`
        : `Used 1 free post slot (${freeUsed + 1}/6) for "${title}" (pending Admin approval).`
    );

    const createdRes = await db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [id] });

    res.json({
      message: "Post submitted and sent to Admin for approval.",
      listing: rowToObj(createdRes),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/listings/:id", async (req, res) => {
  try {
    const payload = req.body || {};
    const fieldError = validateAllPostFieldsRequired(payload);
    if (fieldError) return res.status(400).json({ error: fieldError });

    const existingRes = await db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [req.params.id] });
    const existing = rowToObj(existingRes);
    if (!existing) return res.status(404).json({ error: "Listing not found." });
    if (!payload.seller_id || existing.seller_id !== payload.seller_id) {
      return res.status(403).json({ error: "You can only edit your own post." });
    }
    const user = await getActiveSeller(existing.seller_id, res);
    if (!user) return;

    await db.execute({
      sql: `UPDATE listings SET
        title = ?, vehicle_type = ?, condition_type = ?, brand = ?, model = ?, body_type = ?,
        year = ?, reg_number = ?, fuel_type = ?, transmission = ?, drive_type = ?, air_con = ?,
        engine_cc = ?, mileage_km = ?, part_name = ?, part_make = ?, part_model = ?,
        year_from = ?, year_to = ?, part_condition = ?, part_authenticity = ?,
        price_kes = ?, negotiable = ?, town = ?, description = ?, updated_at = ?
        WHERE id = ?`,
      args: [
        buildListingTitle(payload),
        existing.category === "motor" ? optionalText(payload.vehicle_type) : null,
        existing.category === "motor" ? optionalText(payload.condition_type) : null,
        existing.category === "motor" ? optionalText(payload.brand) : null,
        existing.category === "motor" ? optionalText(payload.model) : null,
        existing.category === "motor" ? optionalText(payload.body_type) : null,
        existing.category === "motor" ? optionalNumber(payload.year) : null,
        existing.category === "motor" ? optionalText(payload.reg_number) : null,
        existing.category === "motor" ? optionalText(payload.fuel_type) : null,
        existing.category === "motor" ? optionalText(payload.transmission) : null,
        existing.category === "motor" ? optionalText(payload.drive_type) : null,
        existing.category === "motor" ? optionalText(payload.air_con) : null,
        existing.category === "motor" ? optionalNumber(payload.engine_cc) : null,
        existing.category === "motor" ? optionalNumber(payload.mileage_km) : null,
        existing.category === "part" ? optionalText(payload.part_name) : null,
        existing.category === "part" ? optionalText(payload.part_make) : null,
        existing.category === "part" ? optionalText(payload.part_model) : null,
        existing.category === "part" ? optionalNumber(payload.year_from) : null,
        existing.category === "part" ? optionalNumber(payload.year_to) : null,
        existing.category === "part" ? optionalText(payload.part_condition) : null,
        existing.category === "part" ? optionalText(payload.part_authenticity) : null,
        optionalNumber(payload.price_kes) ?? 0,
        optionalText(payload.negotiable) || "Yes",
        optionalText(payload.town) || "Nakuru",
        String(payload.description).trim(),
        new Date().toISOString(),
        existing.id,
      ],
    });

    if (Array.isArray(payload.photos)) {
      await db.execute({ sql: "DELETE FROM listing_photos WHERE listing_id = ?", args: [existing.id] });
      for (let idx = 0; idx < payload.photos.slice(0, 6).length; idx++) {
        await db.execute({
          sql: "INSERT INTO listing_photos (id, listing_id, photo_data, sort_order) VALUES (?, ?, ?, ?)",
          args: [crypto.randomUUID(), existing.id, payload.photos[idx], idx],
        });
      }
    }

    const updatedRes = await db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [existing.id] });
    res.json({ message: "Post updated.", listing: rowToObj(updatedRes) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/listings/:id/status", async (req, res) => {
  try {
    const { status, seller_id } = req.body;
    if (!["active", "paused", "sold"].includes(status)) {
      return res.status(400).json({ error: "Status must be active, paused, or sold." });
    }
    const listingRes = await db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [req.params.id] });
    const listing = rowToObj(listingRes);
    if (!listing) return res.status(404).json({ error: "Listing not found." });
    if (!seller_id || listing.seller_id !== seller_id) {
      return res.status(403).json({ error: "You can only change the status of your own post." });
    }
    const user = await getActiveSeller(seller_id, res);
    if (!user) return;
    const update = await db.execute({
      sql: "UPDATE listings SET status = ?, updated_at = ? WHERE id = ? AND seller_id = ?",
      args: [status, new Date().toISOString(), req.params.id, seller_id],
    });
    if (!Number(update.rowsAffected)) return res.status(404).json({ error: "Listing not found." });
    const updatedRes = await db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [req.params.id] });
    const updated = rowToObj(updatedRes);
    res.json({ listing: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/priority/leaderboard", async (req, res) => {
  try {
    const [settingsRes, listRes] = await Promise.all([
      db.execute("SELECT * FROM platform_settings"),
      db.execute("SELECT * FROM listings WHERE status = 'active'"),
    ]);

    const settings = {};
    for (const r of rowsToArray(settingsRes)) settings[r.key] = r.value;
    const baseFee = Number(settings.base_priority_price_kes || 300);

    const todayStr = todayKenyaDate();
    const activeToday = rowsToArray(listRes)
      .filter((l) => String(l.priority_date || "").slice(0, 10) === todayStr && Number(l.priority_amount_kes || 0) > 0)
      .sort((a, b) => Number(b.priority_amount_kes) - Number(a.priority_amount_kes));

    const maxSlots = 20;
    const usedSlots = Math.min(maxSlots, activeToday.length);
    const topBid = activeToday[0] ? Number(activeToday[0].priority_amount_kes) : 0;
    const recommendedForTop1 = topBid >= baseFee ? topBid + 50 : baseFee;

    res.json({
      baseFee,
      maxSlots,
      usedSlots,
      recommendedForTop1,
      leaderboard: activeToday.slice(0, maxSlots),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/listings/:id/prioritize", async (req, res) => {
  try {
    const { amount_kes, payment_ref = "", payer_phone = "" } = req.body;
    const amount = Number(amount_kes);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Valid priority amount in KES is required." });
    }

    const [settingsRes, listRes, allActiveRes] = await Promise.all([
      db.execute("SELECT * FROM platform_settings"),
      db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [req.params.id] }),
      db.execute("SELECT id, priority_date, priority_amount_kes FROM listings WHERE status = 'active'"),
    ]);

    const listing = rowToObj(listRes);
    if (!listing) return res.status(404).json({ error: "Listing not found." });
    if (!req.body?.seller_id || listing.seller_id !== req.body.seller_id) {
      return res.status(403).json({ error: "You can only prioritize your own post." });
    }
    const user = await getActiveSeller(listing.seller_id, res);
    if (!user) return;

    const settings = {};
    for (const r of rowsToArray(settingsRes)) settings[r.key] = r.value;
    const baseFee = Number(settings.base_priority_price_kes || 300);

    if (amount < baseFee) {
      return res.status(400).json({ error: `Minimum priority fee is KES ${baseFee}.` });
    }

    const todayStr = todayKenyaDate();
    const todaySponsored = rowsToArray(allActiveRes).filter(
      (x) => String(x.priority_date || "").slice(0, 10) === todayStr && Number(x.priority_amount_kes || 0) > 0
    );

    const alreadySponsoredToday = todaySponsored.some((x) => x.id === listing.id);
    if (!alreadySponsoredToday && todaySponsored.length >= 20) {
      return res.status(409).json({ error: "All 20 daily sponsored priority slots are full for today." });
    }

    await db.execute({
      sql: "UPDATE listings SET priority_amount_kes = ?, priority_date = ?, updated_at = ? WHERE id = ?",
      args: [amount, todayStr, new Date().toISOString(), listing.id],
    });

    await addSellerNotification(
      listing.seller_id,
      `Prioritized "${listing.title}" for today with KES ${amount}. Higher amounts appear higher in the Top 20.`
    );

    await addPaymentNotification({
      sellerId: listing.seller_id,
      payerName: listing.seller_name,
      payerPhone: payer_phone || listing.whatsapp_phone,
      payerEmail: user.email,
      purpose: `24h Post Priority: ${listing.title}`,
      amountKes: amount,
      paymentRef,
    });

    const updatedRes = await db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [listing.id] });

    res.json({
      message: `"${listing.title}" is now prioritized for today with KES ${amount}.`,
      listing: rowToObj(updatedRes),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= ADMIN ROUTES =================

function subAdminIpHash(req) {
  const address = req.ip || req.socket.remoteAddress || "unknown";
  return crypto.createHash("sha256").update(String(address)).digest("hex");
}

async function checkSubAdminLoginLimit(req, res) {
  const ipHash = subAdminIpHash(req);
  const limitRes = await db.execute({
    sql: "SELECT attempts, locked_until FROM sub_admin_login_limits WHERE ip_hash = ?",
    args: [ipHash],
  });
  const limit = rowToObj(limitRes);
  if (limit?.locked_until && new Date(limit.locked_until).getTime() > Date.now()) {
    res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
    return null;
  }
  if (limit?.locked_until) {
    await db.execute({ sql: "DELETE FROM sub_admin_login_limits WHERE ip_hash = ?", args: [ipHash] });
  }
  return { ipHash, attempts: Number(limit?.attempts || 0) };
}

async function failSubAdminLogin(res, ipHash, attempts) {
  const nextAttempts = attempts + 1;
  const lockedUntil = nextAttempts >= 5
    ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
    : null;
  await db.execute({
    sql: `INSERT INTO sub_admin_login_limits (ip_hash, attempts, locked_until) VALUES (?, ?, ?)
      ON CONFLICT(ip_hash) DO UPDATE SET attempts = excluded.attempts, locked_until = excluded.locked_until`,
    args: [ipHash, nextAttempts, lockedUntil],
  });
  if (nextAttempts >= 5) {
    res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
    return;
  }
  res.status(401).json({ error: "Invalid PIN or verification code." });
}

async function findSubAdminByPin(pin) {
  const adminsRes = await db.execute("SELECT * FROM sub_admins");
  let match = null;
  for (const admin of rowsToArray(adminsRes)) {
    if (verifyPassword(pin, admin.pin_hash)) match = admin;
  }
  return match;
}

async function createSubAdminSession(slot) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  await db.execute({ sql: "DELETE FROM sub_admin_sessions WHERE expires_at <= ?", args: [new Date().toISOString()] });
  await db.execute({
    sql: "INSERT INTO sub_admin_sessions (token_hash, slot, expires_at) VALUES (?, ?, ?)",
    args: [tokenHash, slot, expiresAt],
  });
  return { session_token: token, expires_at: expiresAt };
}

app.post("/api/admin/sub/login", async (req, res) => {
  try {
    const limiter = await checkSubAdminLoginLimit(req, res);
    if (!limiter) return;
    const pin = String(req.body?.pin || "");
    if (!/^\d{6}$/.test(pin)) return failSubAdminLogin(res, limiter.ipHash, limiter.attempts);
    const admin = await findSubAdminByPin(pin);
    if (!admin) return failSubAdminLogin(res, limiter.ipHash, limiter.attempts);
    await db.execute({ sql: "DELETE FROM sub_admin_login_limits WHERE ip_hash = ?", args: [limiter.ipHash] });

    if (Number(admin.email_code_enabled)) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await db.execute({
        sql: "UPDATE sub_admins SET code_hash = ?, code_expires_at = ?, code_failed_attempts = 0 WHERE slot = ?",
        args: [hashSubAdminCode(code), expiresAt, admin.slot],
      });
      try {
        await sendSubAdminCode(admin.email, code);
      } catch (error) {
        await db.execute({
          sql: "UPDATE sub_admins SET code_hash = NULL, code_expires_at = NULL WHERE slot = ?",
          args: [admin.slot],
        });
        throw error;
      }
      return res.json({ requires_code: true, email_hint: maskEmail(admin.email) });
    }

    return res.json(await createSubAdminSession(admin.slot));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/admin/sub/verify", async (req, res) => {
  try {
    const limiter = await checkSubAdminLoginLimit(req, res);
    if (!limiter) return;
    const pin = String(req.body?.pin || "");
    const code = String(req.body?.code || "");
    const admin = /^\d{6}$/.test(pin) && /^\d{6}$/.test(code)
      ? await findSubAdminByPin(pin)
      : null;
    const codeHash = admin?.code_hash ? Buffer.from(hashSubAdminCode(code), "hex") : Buffer.alloc(0);
    const expectedHash = admin?.code_hash ? Buffer.from(admin.code_hash, "hex") : Buffer.alloc(0);
    const codeMatches = codeHash.length === expectedHash.length &&
      codeHash.length > 0 &&
      crypto.timingSafeEqual(codeHash, expectedHash);
    if (
      !admin ||
      !Number(admin.email_code_enabled) ||
      !admin.code_expires_at ||
      new Date(admin.code_expires_at).getTime() <= Date.now() ||
      !codeMatches
    ) {
      if (admin && Number(admin.email_code_enabled)) {
        const failedAttempts = Number(admin.code_failed_attempts || 0) + 1;
        await db.execute({
          sql: `UPDATE sub_admins SET code_failed_attempts = ?, code_hash = ?, code_expires_at = ?
            WHERE slot = ?`,
          args: [
            failedAttempts,
            failedAttempts >= 5 ? null : admin.code_hash,
            failedAttempts >= 5 ? null : admin.code_expires_at,
            admin.slot,
          ],
        });
      }
      return failSubAdminLogin(res, limiter.ipHash, limiter.attempts);
    }

    await db.execute({ sql: "DELETE FROM sub_admin_login_limits WHERE ip_hash = ?", args: [limiter.ipHash] });
    await db.execute({
      sql: "UPDATE sub_admins SET code_hash = NULL, code_expires_at = NULL, code_failed_attempts = 0 WHERE slot = ?",
      args: [admin.slot],
    });
    return res.json(await createSubAdminSession(admin.slot));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/admin/sub/logout", requireAdmin, async (req, res) => {
  try {
    if (req.adminRole === "subadmin") {
      const token = req.get("x-admin-key");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      await db.execute({ sql: "DELETE FROM sub_admin_sessions WHERE token_hash = ?", args: [tokenHash] });
    }
    res.json({ message: "Signed out." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/sub-accounts", requireOwnerAdmin, async (req, res) => {
  try {
    const adminsRes = await db.execute("SELECT slot, email, email_code_enabled FROM sub_admins ORDER BY slot");
    const bySlot = new Map(rowsToArray(adminsRes).map((admin) => [Number(admin.slot), admin]));
    res.json({
      emailjs_configured: Boolean(
        EMAILJS_PUBLIC_KEY && EMAILJS_PRIVATE_KEY && EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID
      ),
      accounts: [1, 2, 3, 4].map((slot) => {
        const admin = bySlot.get(slot);
        return {
          slot,
          active: Boolean(admin),
          email: admin?.email || "",
          email_code_enabled: Boolean(Number(admin?.email_code_enabled || 0)),
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/admin/sub-accounts", requireOwnerAdmin, async (req, res) => {
  try {
    const slots = req.body?.accounts;
    if (!Array.isArray(slots) || slots.length !== 4) {
      return res.status(400).json({ error: "Provide exactly four sub-admin slots." });
    }
    const existingRes = await db.execute("SELECT * FROM sub_admins");
    const existingBySlot = new Map(rowsToArray(existingRes).map((admin) => [Number(admin.slot), admin]));
    const normalized = [];

    for (let index = 0; index < 4; index++) {
      const input = slots[index] || {};
      const slot = index + 1;
      if (Number(input.slot) !== slot) return res.status(400).json({ error: "Sub-admin slots must be numbered 1 to 4." });
      if (!input.active) {
        normalized.push({ slot, active: false });
        continue;
      }
      const email = String(input.email || "").trim().toLowerCase();
      const codeEnabled = Boolean(input.email_code_enabled);
      const pin = String(input.pin || "").trim();
      const existing = existingBySlot.get(slot);
      if (pin && !/^\d{6}$/.test(pin)) {
        return res.status(400).json({ error: `Sub-admin ${slot}: PIN must be exactly 6 digits.` });
      }
      if (!existing && !pin) {
        return res.status(400).json({ error: `Sub-admin ${slot}: enter a 6-digit PIN to create this login.` });
      }
      if (codeEnabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: `Sub-admin ${slot}: a valid email is required when email codes are enabled.` });
      }
      normalized.push({
        slot,
        active: true,
        email: email || null,
        codeEnabled,
        pinHash: pin ? hashSubAdminPin(pin) : existing.pin_hash,
        pin,
      });
    }

    for (const account of normalized.filter((item) => item.active && item.pin)) {
      for (const other of normalized) {
        if (other.active && other.slot !== account.slot && verifyPassword(account.pin, other.pinHash)) {
          return res.status(400).json({ error: "Each sub-admin must have a different PIN." });
        }
      }
    }

    for (const account of normalized) {
      await db.execute({ sql: "DELETE FROM sub_admin_sessions WHERE slot = ?", args: [account.slot] });
      if (!account.active) {
        await db.execute({ sql: "DELETE FROM sub_admins WHERE slot = ?", args: [account.slot] });
        continue;
      }
      await db.execute({
        sql: `INSERT INTO sub_admins
          (slot, pin_hash, email, email_code_enabled, code_hash, code_expires_at, code_failed_attempts, updated_at)
          VALUES (?, ?, ?, ?, NULL, NULL, 0, ?)
          ON CONFLICT(slot) DO UPDATE SET pin_hash = excluded.pin_hash, email = excluded.email,
            email_code_enabled = excluded.email_code_enabled, code_hash = NULL,
            code_expires_at = NULL, code_failed_attempts = 0, updated_at = excluded.updated_at`,
        args: [account.slot, account.pinHash, account.email, account.codeEnabled ? 1 : 0, new Date().toISOString()],
      });
    }
    res.json({ message: "Sub-admin logins saved. Existing sessions have been signed out." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/overview", requireAdmin, async (req, res) => {
  try {
    await syncExpiredListings();

    const [listingsRes, usersRes, plansRes, settingsRes, payNotifsRes] = await Promise.all([
      db.execute("SELECT * FROM listings ORDER BY created_at DESC"),
      db.execute("SELECT * FROM users ORDER BY created_at DESC"),
      db.execute("SELECT * FROM post_plans ORDER BY price_kes ASC"),
      db.execute("SELECT * FROM platform_settings"),
      db.execute("SELECT * FROM payment_notifications ORDER BY created_at DESC LIMIT 100"),
    ]);

    const listings = rowsToArray(listingsRes);
    const listingIds = listings.map((l) => l.id);
    const coverMap = {};

    if (listingIds.length > 0) {
      const placeholders = listingIds.map(() => "?").join(",");
      const photosRes = await db.execute({
        sql: `SELECT listing_id, photo_data, sort_order FROM listing_photos WHERE listing_id IN (${placeholders}) ORDER BY sort_order ASC`,
        args: listingIds,
      });
      for (const p of rowsToArray(photosRes)) {
        if (!coverMap[p.listing_id]) coverMap[p.listing_id] = p.photo_data;
      }
    }

    const enrichedListings = listings.map((l) => ({
      ...l,
      cover_photo: coverMap[l.id] || "",
      days_remaining: computeDaysRemaining(l),
    }));

    const safeUsers = rowsToArray(usersRes).map(sanitizeUser);

    const settings = {};
    for (const r of rowsToArray(settingsRes)) settings[r.key] = r.value;

    res.json({
      listings: enrichedListings,
      users: safeUsers,
      plans: rowsToArray(plansRes),
      settings,
      paymentNotifications: rowsToArray(payNotifsRes),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/admin/listings/:id", requireAdmin, async (req, res) => {
  try {
    const existingRes = await db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [req.params.id] });
    const existing = rowToObj(existingRes);
    if (!existing) return res.status(404).json({ error: "Listing not found." });

    const payload = req.body || {};
    if (!String(payload.description ?? existing.description ?? "").trim()) {
      return res.status(400).json({ error: "Description is required." });
    }
    if (payload.photos !== undefined && (!Array.isArray(payload.photos) || payload.photos.length > 6)) {
      return res.status(400).json({ error: "Please provide no more than 6 photos." });
    }

    const textFields = [
      "title", "seller_name", "seller_slug", "whatsapp_phone", "call_phone", "negotiable", "town", "description",
      "vehicle_type", "condition_type", "brand", "model", "body_type", "reg_number", "fuel_type",
      "transmission", "drive_type", "air_con", "part_name", "part_make", "part_model",
      "part_condition", "part_authenticity",
    ];
    const numberFields = ["price_kes", "year", "engine_cc", "mileage_km", "year_from", "year_to"];
    const updates = [];
    const args = [];

    for (const field of textFields) {
      if (Object.hasOwn(payload, field)) {
        updates.push(`${field} = ?`);
        if (field === "description") {
          args.push(String(payload[field] ?? "").trim());
        } else if (field === "title") {
          args.push(optionalText(payload[field]) || existing.title || buildListingTitle({ ...existing, ...payload }));
        } else if (field === "seller_name") {
          args.push(optionalText(payload[field]) || existing.seller_name);
        } else if (field === "town") {
          args.push(optionalText(payload[field]) || "Nakuru");
        } else if (field === "negotiable") {
          args.push(optionalText(payload[field]) || "Yes");
        } else {
          args.push(optionalText(payload[field]));
        }
      }
    }
    for (const field of numberFields) {
      if (Object.hasOwn(payload, field)) {
        updates.push(`${field} = ?`);
        args.push(optionalNumber(payload[field]) ?? (field === "price_kes" ? 0 : null));
      }
    }
    if (updates.length) {
      updates.push("updated_at = ?");
      args.push(new Date().toISOString(), req.params.id);
      await db.execute({
        sql: `UPDATE listings SET ${updates.join(", ")} WHERE id = ?`,
        args,
      });
    }

    if (Array.isArray(payload.photos)) {
      await db.execute({ sql: "DELETE FROM listing_photos WHERE listing_id = ?", args: [req.params.id] });
      for (let index = 0; index < payload.photos.length; index++) {
        await db.execute({
          sql: "INSERT INTO listing_photos (id, listing_id, photo_data, sort_order) VALUES (?, ?, ?, ?)",
          args: [crypto.randomUUID(), req.params.id, payload.photos[index], index],
        });
      }
    }

    const updatedRes = await db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [req.params.id] });
    res.json({ message: "Listing updated.", listing: rowToObj(updatedRes) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/dealers", requireAdmin, async (req, res) => {
  try {
    const { user_id, name, email, whatsapp_phone, call_phone, town = "Nakuru" } = req.body;

    if (user_id) {
      const userRes = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [user_id] });
      const existing = rowToObj(userRes);
      if (!existing) return res.status(404).json({ error: "Seller account not found." });
      await db.execute({ sql: "UPDATE users SET role = 'dealer' WHERE id = ?", args: [user_id] });
      return res.json({ message: `${existing.name} is now marked as a Dealer.` });
    }

    if (!name || !email || !whatsapp_phone || !call_phone) {
      return res.status(400).json({ error: "Name, email, WhatsApp, and call phone are required to add a dealer." });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const existingRes = await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [cleanEmail] });
    const existing = rowToObj(existingRes);

    if (existing) {
      await db.execute({
        sql: "UPDATE users SET name = ?, whatsapp_phone = ?, call_phone = ?, town = ?, role = 'dealer', shop_slug = ? WHERE id = ?",
        args: [
          String(name).trim(),
          String(whatsapp_phone).trim(),
          String(call_phone).trim(),
          String(town).trim() || "Nakuru",
          existing.shop_slug || slugify(name),
          existing.id,
        ],
      });
      return res.json({ message: `Updated ${String(name).trim()} as a Dealer.` });
    }

    const id = crypto.randomUUID();
    const tempPass = crypto.randomBytes(12).toString("hex");
    const nowIso = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO users
        (id, name, email, password_hash, whatsapp_phone, call_phone, role, town, shop_slug,
         free_posts_used, paid_post_credits, total_purchased_posts, total_spent_kes, is_suspended, terms_accepted_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'dealer', ?, ?, 0, 0, 0, 0, 0, ?, ?)`,
      args: [
        id,
        String(name).trim(),
        cleanEmail,
        hashPassword(tempPass),
        String(whatsapp_phone).trim(),
        String(call_phone).trim(),
        String(town).trim() || "Nakuru",
        slugify(name),
        nowIso,
        nowIso,
      ],
    });

    res.json({ message: `Added dealer "${String(name).trim()}".` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/admin/dealers/:id", requireAdmin, async (req, res) => {
  try {
    const userRes = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [req.params.id] });
    const existing = rowToObj(userRes);
    if (!existing) return res.status(404).json({ error: "Dealer not found." });

    await db.execute({ sql: "UPDATE users SET role = 'private' WHERE id = ?", args: [req.params.id] });
    res.json({ message: `Removed dealer status for ${existing.name}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/listings/:id/moderate", requireAdmin, async (req, res) => {
  try {
    const { action } = req.body;
    const listRes = await db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [req.params.id] });
    const listing = rowToObj(listRes);
    if (!listing) return res.status(404).json({ error: "Listing not found." });

    const nowIso = new Date().toISOString();
    if (action === "approve" && listing.status !== "pending_approval") {
      return res.status(409).json({ error: "Only pending posts can be approved." });
    }
    if (action === "approve" || action === "mark_safe" || action === "unpause") {
      const pubAt = listing.published_at || nowIso;
      await db.execute({
        sql: "UPDATE listings SET status = 'active', report_reason = NULL, rejection_reason = NULL, published_at = ?, updated_at = ? WHERE id = ?",
        args: [pubAt, nowIso, listing.id],
      });
      if (action === "approve" && listing.status === "pending_approval") {
        await addSellerNotification(listing.seller_id, `Your post "${listing.title}" was approved and is now visible in the marketplace.`);
      }
    } else if (action === "reject") {
      const reason = String(req.body?.reason || "").trim();
      if (listing.status !== "pending_approval") {
        return res.status(409).json({ error: "Only pending posts can be rejected." });
      }
      if (!reason) return res.status(400).json({ error: "A rejection reason is required." });
      if (reason.length > 500) return res.status(400).json({ error: "Rejection reason must be 500 characters or fewer." });
      await db.execute({
        sql: "UPDATE listings SET status = 'rejected', rejection_reason = ?, updated_at = ? WHERE id = ?",
        args: [reason, nowIso, listing.id],
      });
      await addSellerNotification(listing.seller_id, `Your post "${listing.title}" was rejected. Reason: ${reason}`);
    } else if (action === "mark_unsafe" || action === "pause") {
      await db.execute({
        sql: "UPDATE listings SET status = 'paused', updated_at = ? WHERE id = ?",
        args: [nowIso, listing.id],
      });
    } else if (action === "sold") {
      await db.execute({
        sql: "UPDATE listings SET status = 'sold', updated_at = ? WHERE id = ?",
        args: [nowIso, listing.id],
      });
    } else {
      return res.status(400).json({ error: "Invalid moderation action." });
    }

    const updatedRes = await db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [listing.id] });
    const updatedListing = rowToObj(updatedRes);
    res.json({
      message: action === "reject"
        ? `Post rejected. The seller was notified. Reason: ${updatedListing.rejection_reason}`
        : action === "approve"
          ? "Post accepted and published. The seller was notified."
          : `Post ${action === "sold" ? "marked as sold" : action === "pause" ? "paused" : action === "unpause" || action === "mark_safe" ? "restored" : "updated"}.`,
      listing: updatedListing,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/users/:id/gift-posts", requireAdmin, async (req, res) => {
  try {
    const count = Number(req.body.posts_count || 0);
    if (!count) return res.status(400).json({ error: "posts_count required." });

    const userRes = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [req.params.id] });
    const user = rowToObj(userRes);
    if (!user) return res.status(404).json({ error: "User not found." });

    const newCredits = Math.max(0, Number(user.paid_post_credits || 0) + count);
    await db.execute({ sql: "UPDATE users SET paid_post_credits = ? WHERE id = ?", args: [newCredits, user.id] });
    await addSellerNotification(user.id, `Admin gifted ${count} post credit(s) to your account.`);
    res.json({ message: "Gifted posts updated." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/users/:id/suspension", requireAdmin, async (req, res) => {
  try {
    const { suspend, reason } = req.body;
    const userRes = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [req.params.id] });
    const user = rowToObj(userRes);
    if (!user) return res.status(404).json({ error: "User not found." });

    await db.execute({
      sql: "UPDATE users SET is_suspended = ?, suspension_reason = ?, appeal_status = ? WHERE id = ?",
      args: [
        suspend ? 1 : 0,
        suspend ? String(reason || "Account suspended") : null,
        suspend ? user.appeal_status : "resolved",
        user.id,
      ],
    });

    if (suspend) {
      await db.execute({
        sql: "UPDATE listings SET status = 'paused' WHERE seller_id = ? AND status = 'active'",
        args: [user.id],
      });
    }

    res.json({ message: suspend ? "Account suspended." : "Account restored." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const { base_priority_price_kes } = req.body;
    await db.execute({
      sql: "INSERT INTO platform_settings (key, value) VALUES ('base_priority_price_kes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [String(Number(base_priority_price_kes))],
    });
    res.json({ message: "Saved." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/admin/plans/:id", requireAdmin, async (req, res) => {
  try {
    const { name, post_count, price_kes } = req.body;
    await db.execute({
      sql: "UPDATE post_plans SET name = ?, post_count = ?, price_kes = ? WHERE id = ?",
      args: [name, Number(post_count), Number(price_kes), req.params.id],
    });
    res.json({ message: "Plan updated." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/plans", requireAdmin, async (req, res) => {
  try {
    const { name, post_count, price_kes } = req.body;
    await db.execute({
      sql: "INSERT INTO post_plans (id, name, post_count, price_kes) VALUES (?, ?, ?, ?)",
      args: [crypto.randomUUID(), name, Number(post_count), Number(price_kes)],
    });
    res.json({ message: "Plan added." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/catalog", requireAdmin, async (req, res) => {
  try {
    const { vehicle_type, brand, model, body_type } = req.body;
    await db.execute({
      sql: "INSERT INTO vehicle_catalog (id, vehicle_type, brand, model, body_type) VALUES (?, ?, ?, ?, ?)",
      args: [crypto.randomUUID(), vehicle_type, brand, model, body_type],
    });
    res.json({ message: "Catalog item added." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initializeDatabaseWithRetry()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Wariara Cars Central Rift API (Turso) running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize Turso database:", err);
    process.exit(1);
  });
