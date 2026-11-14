ALTER TABLE qwen_tool_publication_operation
    ADD COLUMN execution_mode VARCHAR(16) NOT NULL DEFAULT 'SYNC';
ALTER TABLE qwen_tool_publication_operation
    ADD COLUMN verification_request_json MEDIUMTEXT;
ALTER TABLE qwen_tool_publication_operation
    ADD COLUMN verification_ready BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE qwen_tool_publication_operation
    ADD COLUMN verification_next_at DATETIME(6);
ALTER TABLE qwen_tool_publication_operation
    ADD COLUMN failure_status INT;
ALTER TABLE qwen_tool_publication_operation
    ADD COLUMN failure_code VARCHAR(128);

CREATE INDEX ix_tool_publication_verification_due
    ON qwen_tool_publication_operation
    (execution_mode, state, verification_ready, verification_next_at);
