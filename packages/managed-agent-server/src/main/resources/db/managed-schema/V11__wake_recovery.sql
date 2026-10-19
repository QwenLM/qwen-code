ALTER TABLE ma_session_head ADD COLUMN wake_pending BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ma_session_head ADD COLUMN wake_head_revision BIGINT;
ALTER TABLE ma_session_head ADD COLUMN wake_retry_at BIGINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE ma_session_head ADD COLUMN wake_scan_pending BOOLEAN GENERATED ALWAYS AS (wake_pending = TRUE OR wake_head_revision IS NULL OR wake_head_revision <> journal_revision);
CREATE INDEX ix_ma_head_wake ON ma_session_head (wake_scan_pending, wake_retry_at, tenant_key, harness_key);
