-- Store receipt files in R2. The legacy BLOB column remains as a read fallback
-- and is migrated to R2 on first access.
ALTER TABLE receipts ADD COLUMN r2_key TEXT;

CREATE INDEX IF NOT EXISTS receipts_by_r2_key ON receipts(r2_key);
