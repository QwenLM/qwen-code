CREATE TABLE ma_csi_source (
    binding_id VARBINARY(2048) NOT NULL,
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
    publication_hash CHAR(64),
    PRIMARY KEY (binding_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_csi_source_physical ON ma_csi_source (physical_key);
