ALTER TABLE qwen_managed_session_journal_head
    ADD COLUMN activation_id VARCHAR(512);
ALTER TABLE qwen_managed_session_journal_head
    ADD COLUMN activation_phase VARCHAR(32);
ALTER TABLE qwen_managed_session_journal_head
    ADD COLUMN activation_event_epoch BIGINT;
ALTER TABLE qwen_managed_session_journal_head
    ADD COLUMN activation_expires_at BIGINT;
ALTER TABLE qwen_managed_session_journal_head
    ADD COLUMN activation_head_revision BIGINT;
