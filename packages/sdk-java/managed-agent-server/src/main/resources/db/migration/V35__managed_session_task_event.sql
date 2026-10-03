-- A change of a Managed Session's task view, announced in the transaction
-- that commits its revision. This is the task-events outbox, kept out of
-- the Session event stream so an announcement interleaved between two
-- streamed text deltas cannot split a stored message part; the planned
-- task-events feed drains it (H3).
CREATE TABLE qwen_managed_session_task_event (
    session_scope_key CHAR(64) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    task_id VARCHAR(128) NOT NULL,
    task_state VARCHAR(32) NOT NULL,
    revision BIGINT NOT NULL,
    first_sequence BIGINT NOT NULL,
    PRIMARY KEY (session_scope_key, task_id, revision)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

-- The drain reads a Session's announcements in journal order.
CREATE INDEX idx_managed_session_task_event_sequence
    ON qwen_managed_session_task_event (
        session_scope_key, first_sequence, task_id
    );
