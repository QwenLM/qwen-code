CREATE TABLE managed_workspace_recovery_operation (
    operation_id CHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(128) NOT NULL,
    storage_id VARCHAR(256) NOT NULL,
    mode VARCHAR(16) NOT NULL,
    capture_operation_id CHAR(36),
    request_digest CHAR(64) NOT NULL,
    request_json MEDIUMTEXT NOT NULL,
    registration_json MEDIUMTEXT NOT NULL,
    source_digest CHAR(64) NOT NULL,
    session_count BIGINT NOT NULL,
    state VARCHAR(16) NOT NULL,
    manifest_digest CHAR(64),
    last_error_code VARCHAR(64),
    result_json MEDIUMTEXT,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE managed_workspace_recovery_session (
    operation_id CHAR(36) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    source_digest CHAR(64) NOT NULL,
    source_json MEDIUMTEXT NOT NULL,
    state VARCHAR(16) NOT NULL,
    summary_json MEDIUMTEXT,
    PRIMARY KEY (operation_id, session_id),
    FOREIGN KEY (operation_id) REFERENCES managed_workspace_recovery_operation (operation_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE managed_workspace_recovery_work (
    operation_id CHAR(36) NOT NULL,
    work_kind VARCHAR(16) NOT NULL,
    key_hash CHAR(64) NOT NULL,
    work_key VARCHAR(640) NOT NULL,
    session_id VARCHAR(64),
    metadata_json MEDIUMTEXT NOT NULL,
    state VARCHAR(16) NOT NULL,
    PRIMARY KEY (operation_id, work_kind, key_hash),
    FOREIGN KEY (operation_id) REFERENCES managed_workspace_recovery_operation (operation_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_workspace_recovery_asset_page
    ON managed_workspace_recovery_work (operation_id, work_kind, work_key);

CREATE INDEX idx_workspace_recovery_pending_ref
    ON managed_workspace_recovery_work (operation_id, work_kind, session_id, state, key_hash);
