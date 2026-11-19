ALTER TABLE qwen_tool_publication ADD COLUMN producer_phase VARCHAR(32) NOT NULL DEFAULT 'OPEN';
ALTER TABLE qwen_tool_publication ADD COLUMN quarantined BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE qwen_tool_publication ADD COLUMN active_operation_id VARCHAR(128);
ALTER TABLE qwen_tool_publication ADD COLUMN finish_operation_id VARCHAR(128);
ALTER TABLE qwen_tool_publication ADD COLUMN finish_predecessor_id VARCHAR(128);
ALTER TABLE qwen_tool_publication ADD COLUMN finish_digest CHAR(64);
ALTER TABLE qwen_tool_publication ADD COLUMN terminal_resource_id VARCHAR(128);
ALTER TABLE qwen_tool_publication ADD COLUMN admission_resource_id VARCHAR(128);
ALTER TABLE qwen_tool_publication ADD COLUMN receipt_sequence BIGINT;
ALTER TABLE qwen_tool_publication ADD COLUMN receipt_revision BIGINT;
ALTER TABLE qwen_tool_publication ADD COLUMN capture_held_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE qwen_tool_publication ADD COLUMN producer_held_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE qwen_tool_publication ADD COLUMN admission_held_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE qwen_tool_publication ADD COLUMN capture_used_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE qwen_tool_publication ADD COLUMN producer_used_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE qwen_tool_publication ADD COLUMN admission_used_bytes BIGINT NOT NULL DEFAULT 0;

UPDATE qwen_tool_publication SET capture_held_bytes = capture_bytes,
    producer_held_bytes = producer_bytes,
    admission_held_bytes = admission_bytes
    WHERE state <> 'NOT_STARTED';

CREATE TABLE qwen_tool_publication_object (
    scope_key CHAR(64) NOT NULL,
    publication_id VARCHAR(128) NOT NULL,
    slot_key VARCHAR(256) NOT NULL,
    resource_id VARCHAR(128),
    resource_kind VARCHAR(128),
    byte_length BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    object_key VARCHAR(512),
    inline_bytes MEDIUMBLOB,
    state VARCHAR(32) NOT NULL,
    operation_id VARCHAR(128) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (scope_key, publication_id, slot_key),
    CONSTRAINT uq_tool_publication_resource
        UNIQUE (scope_key, resource_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE qwen_tool_publication_operation (
    scope_key CHAR(64) NOT NULL,
    publication_id VARCHAR(128) NOT NULL,
    operation_id VARCHAR(128) NOT NULL,
    request_digest CHAR(64) NOT NULL,
    slot_key VARCHAR(256),
    state VARCHAR(32) NOT NULL,
    claim_owner VARCHAR(128),
    claim_epoch BIGINT NOT NULL,
    claim_until DATETIME(6),
    deadline DATETIME(6) NOT NULL,
    receipt_json MEDIUMTEXT,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (scope_key, publication_id, operation_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE qwen_tool_publication_seal (
    scope_key CHAR(64) NOT NULL,
    publication_id VARCHAR(128) NOT NULL,
    stream_id VARCHAR(16) NOT NULL,
    segment_count INT NOT NULL,
    byte_length BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    operation_id VARCHAR(128) NOT NULL,
    PRIMARY KEY (scope_key, publication_id, stream_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
