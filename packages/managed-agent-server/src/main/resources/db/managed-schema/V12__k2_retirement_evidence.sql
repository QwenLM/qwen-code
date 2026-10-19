ALTER TABLE ma_operation ADD COLUMN progress_format VARCHAR(64);
ALTER TABLE ma_operation ADD COLUMN progress_version BIGINT;
ALTER TABLE ma_operation ADD COLUMN progress_stage VARCHAR(16);
ALTER TABLE ma_operation ADD COLUMN settlement_deadline_ms BIGINT;
ALTER TABLE ma_operation ADD COLUMN frozen_request_bytes LONGBLOB;
ALTER TABLE ma_operation ADD COLUMN frozen_request_sha256 CHAR(64);
ALTER TABLE ma_operation ADD COLUMN cut_bytes LONGBLOB;
ALTER TABLE ma_operation ADD COLUMN cut_sha256 CHAR(64);
ALTER TABLE ma_operation ADD COLUMN finalize_receipt_bytes LONGBLOB;
ALTER TABLE ma_operation ADD COLUMN finalize_receipt_sha256 CHAR(64);
ALTER TABLE ma_operation ADD COLUMN csi_retirement_target_key CHAR(64) GENERATED ALWAYS AS (CASE WHEN operation_kind = 'CSI_RETIREMENT' THEN target_key ELSE NULL END);
ALTER TABLE ma_operation ADD CONSTRAINT uq_ma_csi_retirement_target UNIQUE (csi_retirement_target_key, target_revision);

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

CREATE TABLE ma_csi_physical (
    retirement_id CHAR(36) NOT NULL,
    binding_id VARBINARY(2048) NOT NULL,
    physical_key CHAR(64) NOT NULL,
    record_version BIGINT NOT NULL,
    record_bytes LONGBLOB NOT NULL,
    record_sha256 CHAR(64) NOT NULL,
    PRIMARY KEY (retirement_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE UNIQUE INDEX uq_ma_csi_physical_binding ON ma_csi_physical (binding_id);
CREATE INDEX ix_ma_csi_physical_key ON ma_csi_physical (physical_key);
