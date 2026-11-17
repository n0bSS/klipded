-- KlipDed license and usage schema (Cloudflare D1 / SQLite)
-- Run once:  npx wrangler d1 execute klipded --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS licenses (
  license_key   TEXT PRIMARY KEY,
  plan          TEXT NOT NULL DEFAULT 'custom',
  note          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',   -- active | revoked
  duration_days INTEGER NOT NULL DEFAULT 30,      -- counted from first use
  quota_seconds INTEGER NOT NULL DEFAULT 36000,   -- seconds of video audio allowed
  used_seconds  INTEGER NOT NULL DEFAULT 0,
  max_devices   INTEGER NOT NULL DEFAULT 2,
  devices       TEXT NOT NULL DEFAULT '[]',       -- JSON array of device ids
  created_at    TEXT NOT NULL,
  activated_at  TEXT,
  expires_at    TEXT,
  last_used_at  TEXT
);

CREATE TABLE IF NOT EXISTS usage_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT NOT NULL,
  kind        TEXT NOT NULL,                      -- transcribe | highlights
  seconds     INTEGER NOT NULL DEFAULT 0,
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_key_time ON usage_log (license_key, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_log (created_at);
CREATE INDEX IF NOT EXISTS idx_licenses_created ON licenses (created_at);
