ALTER TABLE managed_agent_operation ADD COLUMN lifecycle_protocol_version INT NOT NULL DEFAULT 0;
ALTER TABLE managed_agent_operation ADD COLUMN lifecycle_effects_receipt_json LONGTEXT;
ALTER TABLE qwen_runtime_harness_drain ADD COLUMN phase VARCHAR(32) NOT NULL DEFAULT 'DRAINING';
ALTER TABLE qwen_runtime_harness_drain ADD COLUMN operation_id VARCHAR(128);
ALTER TABLE qwen_runtime_harness_drain ADD COLUMN claim_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE qwen_runtime_harness_drain ADD COLUMN claim_lease_until BIGINT;
