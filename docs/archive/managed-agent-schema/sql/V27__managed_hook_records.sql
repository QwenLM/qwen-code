ALTER TABLE qwen_managed_session_extension_record
    ADD COLUMN first_sequence BIGINT NOT NULL DEFAULT 0;
