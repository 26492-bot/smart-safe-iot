/**
 * Database Module for IoT Smart Safe
 * Uses native node:sqlite (Node >= 22.5) with automatic fallback to JSON file store
 * Ensures 100% compatibility across all operating systems without native build tools.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'smart_safe.db');
const JSON_BACKUP_PATH = path.join(__dirname, 'smart_safe_fallback.json');

// Password hashing helpers
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 32, 'sha256').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, storedSalt) {
  if (!storedHash || !storedSalt) return false;
  const hash = crypto.pbkdf2Sync(password, storedSalt, 1000, 32, 'sha256').toString('hex');
  return hash === storedHash;
}

// Check if native node:sqlite is available
let dbInstance = null;
let useNativeSqlite = false;

try {
  const { DatabaseSync } = require('node:sqlite');
  dbInstance = new DatabaseSync(DB_PATH);
  useNativeSqlite = true;
  console.log('[DB] Using native Node.js SQLite engine at:', DB_PATH);
} catch (err) {
  console.warn('[DB] Native node:sqlite not available, using JSON file storage fallback:', err.message);
  useNativeSqlite = false;
}

// Fallback JSON in-memory store
let jsonStore = {
  config: {},
  logs: []
};

function loadJsonStore() {
  if (fs.existsSync(JSON_BACKUP_PATH)) {
    try {
      jsonStore = JSON.parse(fs.readFileSync(JSON_BACKUP_PATH, 'utf8'));
    } catch (e) {
      console.error('[DB] Error loading fallback JSON:', e);
    }
  }
}

function saveJsonStore() {
  try {
    fs.writeFileSync(JSON_BACKUP_PATH, JSON.stringify(jsonStore, null, 2), 'utf8');
  } catch (e) {
    console.error('[DB] Error saving fallback JSON:', e);
  }
}

/**
 * Initialize Database Tables and Default Configuration
 */
function initDb() {
  const defaultSalt = crypto.randomBytes(16).toString('hex');
  const defaultHash = crypto.pbkdf2Sync('1234', defaultSalt, 1000, 32, 'sha256').toString('hex');

  if (useNativeSqlite) {
    // Create config table
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS safe_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Create logs table
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS safe_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL
      );
    `);

    // Insert initial config if not exists
    const checkStmt = dbInstance.prepare(`SELECT value FROM safe_config WHERE key = 'password_hash'`);
    const existing = checkStmt.get();

    if (!existing) {
      const now = new Date().toISOString();
      const insertStmt = dbInstance.prepare(`INSERT INTO safe_config (key, value, updated_at) VALUES (?, ?, ?)`);
      insertStmt.run('password_hash', defaultHash, now);
      insertStmt.run('password_salt', defaultSalt, now);
      insertStmt.run('pin_plaintext', '1234', now); // Used strictly for device initial sync over secure internal API
      insertStmt.run('safe_state', 'LOCKED', now);
      console.log('[DB] Initialized default safe password to "1234"');
    }
  } else {
    loadJsonStore();
    if (!jsonStore.config.password_hash) {
      const now = new Date().toISOString();
      jsonStore.config = {
        password_hash: defaultHash,
        password_salt: defaultSalt,
        pin_plaintext: '1234',
        safe_state: 'LOCKED',
        updated_at: now
      };
      if (!jsonStore.logs) jsonStore.logs = [];
      saveJsonStore();
      console.log('[DB Fallback] Initialized default safe password to "1234"');
    }
  }
}

/**
 * Validate Current Safe Password
 */
function checkPassword(inputPassword) {
  if (useNativeSqlite) {
    const hashStmt = dbInstance.prepare(`SELECT value FROM safe_config WHERE key = 'password_hash'`);
    const saltStmt = dbInstance.prepare(`SELECT value FROM safe_config WHERE key = 'password_salt'`);
    const hashRow = hashStmt.get();
    const saltRow = saltStmt.get();

    if (!hashRow || !saltRow) return false;
    return verifyPassword(inputPassword, hashRow.value, saltRow.value);
  } else {
    loadJsonStore();
    return verifyPassword(inputPassword, jsonStore.config.password_hash, jsonStore.config.password_salt);
  }
}

/**
 * Update Safe Password
 */
function updateSafePassword(newPassword) {
  const { hash, salt } = hashPassword(newPassword);
  const now = new Date().toISOString();

  if (useNativeSqlite) {
    const updateStmt = dbInstance.prepare(`
      INSERT INTO safe_config (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `);
    updateStmt.run('password_hash', hash, now);
    updateStmt.run('password_salt', salt, now);
    updateStmt.run('pin_plaintext', newPassword, now);
  } else {
    loadJsonStore();
    jsonStore.config.password_hash = hash;
    jsonStore.config.password_salt = salt;
    jsonStore.config.pin_plaintext = newPassword;
    jsonStore.config.updated_at = now;
    saveJsonStore();
  }
  return true;
}

/**
 * Get Current PIN for Device Sync (Internal only)
 */
function getDevicePin() {
  if (useNativeSqlite) {
    const stmt = dbInstance.prepare(`SELECT value FROM safe_config WHERE key = 'pin_plaintext'`);
    const row = stmt.get();
    return row ? row.value : '1234';
  } else {
    loadJsonStore();
    return jsonStore.config.pin_plaintext || '1234';
  }
}

/**
 * Add an audit log entry (Safe unlock or failed attempt)
 */
function addLog(source, status, details = '') {
  const now = new Date().toISOString();

  if (useNativeSqlite) {
    const stmt = dbInstance.prepare(`
      INSERT INTO safe_logs (source, status, details, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(source, status, details, now);

    // Update safe_state if status is SUCCESS
    if (status === 'SUCCESS') {
      const stateStmt = dbInstance.prepare(`
        INSERT INTO safe_config (key, value, updated_at)
        VALUES ('safe_state', 'UNLOCKED', ?)
        ON CONFLICT(key) DO UPDATE SET value='UNLOCKED', updated_at=excluded.updated_at
      `);
      stateStmt.run(now);
    }
  } else {
    loadJsonStore();
    const newId = (jsonStore.logs.length > 0 ? jsonStore.logs[jsonStore.logs.length - 1].id : 0) + 1;
    jsonStore.logs.push({
      id: newId,
      source,
      status,
      details,
      created_at: now
    });
    if (status === 'SUCCESS') {
      jsonStore.config.safe_state = 'UNLOCKED';
    }
    saveJsonStore();
  }
}

/**
 * Get Logs List
 */
function getLogs(limit = 100) {
  if (useNativeSqlite) {
    const stmt = dbInstance.prepare(`
      SELECT id, source, status, details, created_at
      FROM safe_logs
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  } else {
    loadJsonStore();
    return [...jsonStore.logs].reverse().slice(0, limit);
  }
}

/**
 * Get Dashboard Statistics
 */
function getStats() {
  if (useNativeSqlite) {
    const successStmt = dbInstance.prepare(`SELECT COUNT(*) as count FROM safe_logs WHERE status = 'SUCCESS'`);
    const failedStmt = dbInstance.prepare(`SELECT COUNT(*) as count FROM safe_logs WHERE status = 'FAILED'`);
    const lastLogStmt = dbInstance.prepare(`SELECT source, status, created_at FROM safe_logs ORDER BY id DESC LIMIT 1`);
    const stateStmt = dbInstance.prepare(`SELECT value FROM safe_config WHERE key = 'safe_state'`);

    const successCount = successStmt.get()?.count || 0;
    const failedCount = failedStmt.get()?.count || 0;
    const lastActivity = lastLogStmt.get() || null;
    const safeState = stateStmt.get()?.value || 'LOCKED';

    return {
      successCount,
      failedCount,
      totalSuccess: successCount,
      totalFailed: failedCount,
      totalCount: successCount + failedCount,
      lastActivity,
      safeState
    };
  } else {
    loadJsonStore();
    const successCount = jsonStore.logs.filter(l => l.status === 'SUCCESS').length;
    const failedCount = jsonStore.logs.filter(l => l.status === 'FAILED').length;
    const lastActivity = jsonStore.logs.length > 0 ? jsonStore.logs[jsonStore.logs.length - 1] : null;
    const safeState = jsonStore.config.safe_state || 'LOCKED';

    return {
      successCount,
      failedCount,
      totalSuccess: successCount,
      totalFailed: failedCount,
      totalCount: successCount + failedCount,
      lastActivity,
      safeState
    };
  }
}

module.exports = {
  initDb,
  checkPassword,
  updateSafePassword,
  getDevicePin,
  addLog,
  getLogs,
  getStats
};
