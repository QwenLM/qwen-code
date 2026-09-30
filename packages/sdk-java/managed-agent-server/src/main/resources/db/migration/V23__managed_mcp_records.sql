-- MCP records retain their own lifecycle without becoming Session tasks.
ALTER TABLE qwen_managed_session_extension_record
    MODIFY COLUMN task_kind VARCHAR(32) NULL;
ALTER TABLE qwen_managed_session_extension_record
    MODIFY COLUMN task_state VARCHAR(32) NULL;
