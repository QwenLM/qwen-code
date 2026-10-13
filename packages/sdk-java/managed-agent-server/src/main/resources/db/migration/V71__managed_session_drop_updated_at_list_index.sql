-- The previous (tenant_id, updated_at, session_id) list index loses its
-- only consumer to V70's created_at keyset — the dispatch scans that
-- share its column list read managed_agent_turn, not this table — so it
-- goes away rather than rotting to dead weight. The DROP is its own
-- migration so a failed DROP retries cleanly (see V70's note).
DROP INDEX managed_agent_session_list_idx ON managed_agent_session;
