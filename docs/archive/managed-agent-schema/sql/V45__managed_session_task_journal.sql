-- The bounded per-task event journal of a Managed Session's tasks (H3 of
-- #12827): one row per committed task event, written in the transaction that
-- commits the revision or durable output that produces it, so the task
-- events routes read a committed prefix and never an event ahead of its
-- commit. One logical cursor position per event; the sequence is assigned
-- under the Session's journal head lock, in commit order.
-- Named a journal, not qwen_managed_session_task_event, because the H0c
-- follow-up fixes in flight reserve that name for the task-view outbox the
-- event feed would drain from.
CREATE TABLE qwen_managed_session_task_journal (
    session_scope_key CHAR(64) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    task_id VARCHAR(128) NOT NULL,
    event_sequence BIGINT NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    occurred_at BIGINT NOT NULL,
    schema_version INT NOT NULL,
    projection_version INT NOT NULL,
    state VARCHAR(32),
    runtime_state VARCHAR(32),
    text MEDIUMTEXT,
    truncated TINYINT(1),
    artifact_id VARCHAR(512),
    capture_id VARCHAR(128),
    stream_id VARCHAR(128),
    first_ordinal BIGINT,
    end_ordinal BIGINT,
    archived TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (session_scope_key, task_id, event_sequence)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

-- The durable per-task positions the journal serves from: the last assigned
-- sequence (the committed tail the task view's output cursor points past),
-- the retention floor (the position after the newest expired event), and the
-- task's newest unique artifact references. The floor lives here and not in
-- the event rows, so it survives an empty retained set, restarts and
-- projection rebuilds; only an oldest prefix may expire, and never past an
-- output event whose full text is not yet durably archived.
CREATE TABLE qwen_managed_session_task_journal_cursor (
    session_scope_key CHAR(64) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    task_id VARCHAR(128) NOT NULL,
    last_sequence BIGINT NOT NULL DEFAULT 0,
    expired_through BIGINT NOT NULL DEFAULT 0,
    artifact_refs MEDIUMTEXT NOT NULL,
    PRIMARY KEY (session_scope_key, task_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
