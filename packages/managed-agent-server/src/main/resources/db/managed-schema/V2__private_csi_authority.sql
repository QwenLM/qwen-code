ALTER TABLE ma_session ADD COLUMN runtime_request_key CHAR(64);
ALTER TABLE ma_session ADD COLUMN csi_guard BOOLEAN GENERATED ALWAYS AS (COALESCE(tool_profile = 'csi-files-retirement/1' OR runtime_request_key IS NOT NULL, FALSE));
CREATE INDEX ma_session_csi_guard_idx ON ma_session (tenant_id, session_id, csi_guard);
ALTER TABLE ma_runtime_binding ADD COLUMN first_activation_journal_revision BIGINT;
ALTER TABLE ma_tool_execution ADD COLUMN native_authorization_json LONGTEXT;
