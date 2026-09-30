CREATE TABLE managed_agent_tool_result (
    result_id VARCHAR(80) NOT NULL PRIMARY KEY,
    scope_key CHAR(64) NOT NULL,
    execution_key CHAR(64) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    source_json MEDIUMTEXT NOT NULL,
    source_digest CHAR(64) NOT NULL,
    work_state VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    claim_generation BIGINT NOT NULL DEFAULT 0,
    claim_until BIGINT,
    next_attempt_at BIGINT NOT NULL DEFAULT 0,
    attempts INT NOT NULL DEFAULT 0,
    failure_code VARCHAR(128),
    item_id VARCHAR(128),
    descriptor_json MEDIUMTEXT,
    policy_version VARCHAR(128),
    CONSTRAINT uq_managed_tool_result_source UNIQUE (scope_key, execution_key)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_managed_tool_result_work ON managed_agent_tool_result (work_state, next_attempt_at, result_id);
CREATE INDEX idx_managed_tool_result_lease ON managed_agent_tool_result (work_state, claim_until, result_id);
CREATE INDEX idx_managed_tool_result_item ON managed_agent_tool_result (scope_key, item_id);

CREATE TABLE managed_agent_artifact (
    artifact_id VARCHAR(80) NOT NULL PRIMARY KEY,
    result_id VARCHAR(80) NOT NULL,
    scope_key CHAR(64) NOT NULL,
    descriptor_json MEDIUMTEXT NOT NULL,
    publication_id VARCHAR(128) NOT NULL,
    binding_json MEDIUMTEXT NOT NULL,
    manifest_ref_json MEDIUMTEXT NOT NULL,
    stream_id VARCHAR(128) NOT NULL,
    creation_sequence BIGINT NOT NULL,
    CONSTRAINT uq_managed_artifact_stream UNIQUE (result_id, stream_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_managed_artifact_page ON managed_agent_artifact (scope_key, creation_sequence, artifact_id);

ALTER TABLE qwen_managed_session_journal_head ADD COLUMN o3_backfill_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE qwen_managed_session_journal_head ADD COLUMN o3_backfill_through BIGINT;
ALTER TABLE qwen_managed_session_journal_head ADD COLUMN o3_backfill_error VARCHAR(128);

ALTER TABLE qwen_managed_session_journal_head ADD COLUMN o3_backfill_pending BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX idx_managed_o3_backfill ON qwen_managed_session_journal_head (o3_backfill_pending, tenant_id, session_id);
