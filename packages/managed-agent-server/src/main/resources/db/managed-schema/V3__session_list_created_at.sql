-- Session lists page on the immutable gmt_create keyset: gmt_modified moves on every event append.
DROP INDEX ix_ma_session_list ON ma_session;
CREATE INDEX ix_ma_session_list ON ma_session (tenant_id, gmt_create, session_id);
