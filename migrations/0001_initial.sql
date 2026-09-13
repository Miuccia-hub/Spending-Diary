CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  identifier_type TEXT NOT NULL CHECK(identifier_type IN ('email', 'phone')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  full_name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '澳大利亚',
  display_currency TEXT NOT NULL DEFAULT 'AUD',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledgers (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  entries_json TEXT NOT NULL DEFAULT '[]',
  assets_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

-- The client caps uploads below 900k base64 characters, keeping each JPEG
-- comfortably beneath D1's 1 MB row limit until R2 is enabled on the account.
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  image BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS receipts_by_user ON receipts(user_id);
