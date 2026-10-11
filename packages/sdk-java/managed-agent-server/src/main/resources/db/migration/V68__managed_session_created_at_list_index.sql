-- listSessions pages on the immutable created_at keyset. The previous
-- (tenant_id, updated_at, session_id) list index loses its only consumer —
-- the dispatch scans that share its column list read managed_agent_turn, not
-- this table — so it goes away rather than rotting to dead weight.
CREATE INDEX managed_agent_session_created_idx
    ON managed_agent_session (tenant_id, created_at, session_id);
DROP INDEX managed_agent_session_list_idx ON managed_agent_session;
