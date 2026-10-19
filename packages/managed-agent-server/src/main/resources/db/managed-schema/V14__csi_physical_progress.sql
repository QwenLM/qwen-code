CREATE TABLE ma_csi_physical (
    retirement_id CHAR(36) NOT NULL PRIMARY KEY,
    binding_id VARBINARY(2048) NOT NULL,
    physical_key CHAR(64) NOT NULL,
    record_version BIGINT NOT NULL,
    record_bytes LONGBLOB NOT NULL,
    record_sha256 CHAR(64) NOT NULL,
    UNIQUE (binding_id),
    UNIQUE (physical_key)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
