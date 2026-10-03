-- readIntent resolves a tool.intent's revision by its sequence range; the
-- last_sequence prefix lets the index seek the candidate revision directly
-- instead of scanning the session's whole journal.
CREATE INDEX managed_session_journal_tx_sequence_idx
    ON qwen_managed_session_journal_tx (tenant_id, session_id, last_sequence);
