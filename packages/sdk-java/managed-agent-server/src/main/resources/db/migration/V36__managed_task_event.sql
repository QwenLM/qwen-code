-- The task-event outbox of each Managed Session (H0c of #12827): one row
-- per change of a task's SessionTaskView, written in the transaction that
-- commits the revision, so the slice that serves task events can drain it.
-- The announcement stays out of the Session event stream
-- (managed_agent_event), whose sequence the message projection reads, so it
-- can never sit between two streamed text deltas of one message part.
CREATE TABLE managed_agent_task_event (
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    sequence_id BIGINT NOT NULL,
    task_id VARCHAR(128) NOT NULL,
    task_state VARCHAR(32) NOT NULL,
    revision BIGINT NOT NULL,
    source_key VARCHAR(256) NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, session_id, sequence_id),
    UNIQUE (tenant_id, session_id, source_key),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES managed_agent_session (tenant_id, session_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
