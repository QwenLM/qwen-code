ALTER TABLE ma_runtime_session ADD execution_storage_key CHAR(64);
ALTER TABLE ma_runtime_session ADD execution_exclusive BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX ix_ma_runtime_execution_storage ON ma_runtime_session (execution_storage_key);
