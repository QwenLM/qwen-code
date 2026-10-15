CREATE TABLE qwen_tool_publication_tenant (
    tenant_key CHAR(64) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(128) NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE qwen_tool_publication (
    scope_key CHAR(64) NOT NULL,
    tenant_key CHAR(64) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    publication_id VARCHAR(128) NOT NULL,
    execution_key CHAR(64) NOT NULL,
    capture_id VARCHAR(128) NOT NULL,
    binding_json MEDIUMTEXT NOT NULL,
    binding_digest CHAR(64) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    state VARCHAR(32) NOT NULL,
    expires_at BIGINT,
    capture_bytes BIGINT NOT NULL,
    producer_bytes BIGINT NOT NULL,
    admission_bytes BIGINT NOT NULL,
    PRIMARY KEY (scope_key, publication_id),
    CONSTRAINT uq_tool_publication_execution UNIQUE (scope_key, execution_key),
    CONSTRAINT uq_tool_publication_capture UNIQUE (scope_key, capture_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_tool_publication_tenant ON qwen_tool_publication (tenant_key, state);
