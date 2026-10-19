ALTER TABLE qwen_runtime_binding
    ADD COLUMN first_activation_journal_revision BIGINT;

ALTER TABLE managed_agent_session
    ADD COLUMN csi_guard BOOLEAN GENERATED ALWAYS AS (
        CASE WHEN tool_profile = 'csi-files-retirement/1'
            OR runtime_request_key IS NOT NULL THEN TRUE ELSE FALSE END
    );

CREATE UNIQUE INDEX managed_session_csi_guard_idx
    ON managed_agent_session (tenant_id, session_id, csi_guard);
