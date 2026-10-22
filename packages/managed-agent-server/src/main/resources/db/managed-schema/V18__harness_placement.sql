ALTER TABLE ma_session ADD COLUMN harness_instance_id VARBINARY(144);
ALTER TABLE ma_session ADD COLUMN harness_owner_boot_id VARBINARY(144);
ALTER TABLE ma_session ADD COLUMN harness_placement_epoch BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ma_session ADD COLUMN harness_placement_state VARCHAR(16) NOT NULL DEFAULT 'UNASSIGNED';
ALTER TABLE ma_session ADD CONSTRAINT ck_ma_harness_placement CHECK ((harness_placement_state = 'UNASSIGNED' AND harness_instance_id IS NULL AND harness_owner_boot_id IS NULL AND harness_placement_epoch = 0) OR (harness_instance_id IS NOT NULL AND harness_owner_boot_id IS NOT NULL AND harness_placement_epoch > 0 AND (CASE harness_placement_state WHEN 'ACTIVE' THEN 6 WHEN 'QUIESCING' THEN 9 WHEN 'RELEASED' THEN 8 ELSE -1 END = CHAR_LENGTH(harness_placement_state))));
CREATE INDEX ix_ma_harness_owner ON ma_session (harness_instance_id, harness_owner_boot_id, harness_placement_state, tenant_id, session_id);
