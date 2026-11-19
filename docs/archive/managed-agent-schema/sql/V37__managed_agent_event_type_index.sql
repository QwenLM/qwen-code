-- The session-list assembly looks up the latest turn.accepted /
-- environment event per Session; without an event_type prefix in the
-- index those reads scan the Session's whole event history.
CREATE INDEX managed_agent_event_type_idx
    ON managed_agent_event (tenant_id, session_id, event_type, sequence_id);
