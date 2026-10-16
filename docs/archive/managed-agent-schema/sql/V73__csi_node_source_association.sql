CREATE TABLE managed_workspace_csi_source (
    binding_id VARCHAR(512) PRIMARY KEY,
    runtime_generation BIGINT NOT NULL,
    physical_key CHAR(64) NOT NULL,
    reservation_id CHAR(36) NOT NULL,
    reservation_revision BIGINT NOT NULL,
    configuration_json LONGTEXT NOT NULL,
    phase VARCHAR(16) NOT NULL,
    record_version BIGINT NOT NULL,
    arm_bytes LONGBLOB NOT NULL,
    arm_sequence BIGINT NOT NULL,
    arm_hash CHAR(64) NOT NULL,
    pod_uid CHAR(36),
    gated_spec_sha256 CHAR(64),
    bound_bytes LONGBLOB,
    bound_sequence BIGINT,
    bound_hash CHAR(64),
    publication_bytes LONGBLOB,
    publication_sequence BIGINT,
    publication_hash CHAR(64)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_workspace_csi_source_physical ON managed_workspace_csi_source (physical_key);
