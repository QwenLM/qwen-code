-- listSessions pages on the immutable created_at keyset.
-- CREATE INDEX and DROP INDEX stay in separate migrations: on
-- MySQL/MariaDB each DDL statement implicit-commits, so a packed pair
-- would leave a failed migration unable to retry — the retried CREATE
-- would meet the committed index and fail on the duplicate name.
CREATE INDEX managed_agent_session_created_idx
    ON managed_agent_session (tenant_id, created_at, session_id);
