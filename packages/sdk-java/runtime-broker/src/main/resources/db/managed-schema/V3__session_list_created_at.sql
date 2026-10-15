-- Session lists page on the immutable created_at keyset: updated_at moves on every event append.
DROP INDEX ix_ma_session_list ON ma_session;
CREATE INDEX ix_ma_session_list ON ma_session (tenant_id, created_at, session_id);
