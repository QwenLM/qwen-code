ALTER TABLE ma_session_head ADD COLUMN cleanup_head_revision BIGINT;
ALTER TABLE ma_resource_ref ADD COLUMN runtime_binding_key CHAR(64);
ALTER TABLE ma_resource_ref DROP CONSTRAINT ck_ma_ref_owner;
ALTER TABLE ma_resource_ref ADD CONSTRAINT ck_ma_ref_owner CHECK ((CASE owner_kind WHEN 'JOURNAL' THEN 7 WHEN 'SNAPSHOT' THEN 8 WHEN 'CAPTURE' THEN 7 WHEN 'ARTIFACT' THEN 8 WHEN 'MESSAGE' THEN 7 WHEN 'SESSION_RECORD' THEN 14 WHEN 'EVENT_STREAM' THEN 12 WHEN 'OPERATION' THEN 9 WHEN 'OPERATION_WORK' THEN 14 WHEN 'RECOVERY' THEN 8 WHEN 'HOSTED_CLEANUP' THEN 14 ELSE -1 END = CHAR_LENGTH(owner_kind)));
ALTER TABLE ma_resource_ref ADD CONSTRAINT ck_ma_ref_binding CHECK ((owner_kind = 'HOSTED_CLEANUP' AND runtime_binding_key IS NOT NULL AND owner_revision > 0) OR (owner_kind <> 'HOSTED_CLEANUP' AND runtime_binding_key IS NULL));
CREATE INDEX ix_ma_ref_binding ON ma_resource_ref (owner_kind, runtime_binding_key, owner_revision);
CREATE INDEX ix_ma_head_session ON ma_session_head (tenant_key, session_id, head_kind);
