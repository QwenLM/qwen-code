CREATE TABLE qwen_output_session_retirement (
    tenant_key CHAR(64) NOT NULL,
    session_key CHAR(64) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    operation_id VARCHAR(128) NOT NULL,
    generation BIGINT NOT NULL,
    retired_at BIGINT NOT NULL,
    recovery_protected BOOLEAN NOT NULL,
    PRIMARY KEY (tenant_key, session_key)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

ALTER TABLE qwen_tool_publication
    ADD COLUMN retention_state VARCHAR(32) NOT NULL DEFAULT 'PINNED';
ALTER TABLE qwen_tool_publication ADD COLUMN write_evidence BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE qwen_tool_publication ADD COLUMN accepted_complete BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX idx_tool_publication_retention ON qwen_tool_publication (retention_state);
CREATE INDEX idx_tool_publication_session ON qwen_tool_publication (tenant_id, session_id);

CREATE TABLE qwen_output_read_lease (
    lease_id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_key CHAR(64) NOT NULL,
    session_key CHAR(64) NOT NULL,
    retirement_generation BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE INDEX idx_output_read_session ON qwen_output_read_lease (tenant_key, session_key, expires_at);

CREATE TABLE qwen_output_put_attempt (
    attempt_id VARCHAR(36) NOT NULL PRIMARY KEY,
    scope_key CHAR(64) NOT NULL,
    publication_id VARCHAR(128) NOT NULL,
    object_key VARCHAR(1024) NOT NULL,
    state VARCHAR(32) NOT NULL,
    started_at BIGINT NOT NULL,
    completed_at BIGINT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE INDEX idx_output_put_publication ON qwen_output_put_attempt (scope_key, publication_id, state);
