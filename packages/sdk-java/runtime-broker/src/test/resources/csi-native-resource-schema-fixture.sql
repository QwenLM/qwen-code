-- Resource-table fixture copied from managed-agent-server V4; no native admission authority.
CREATE TABLE qwen_managed_session_resource (
    session_scope_key CHAR(64) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    resource_id VARCHAR(512) NOT NULL,
    kind VARCHAR(512) NOT NULL,
    schema_version INT NOT NULL,
    byte_length BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    storage_kind VARCHAR(32) NOT NULL,
    inline_bytes MEDIUMBLOB,
    object_key VARCHAR(2048),
    object_version_id VARCHAR(512),
    encryption_key_id VARCHAR(512),
    publish_command_id VARCHAR(512) NOT NULL,
    state VARCHAR(32) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    last_verified_at DATETIME(6),
    retention_until DATETIME(6),
    PRIMARY KEY (session_scope_key, resource_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
