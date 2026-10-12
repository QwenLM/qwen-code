-- #13930: a reloaded Harness asks the Broker which of its Runtime Sessions a
-- live hold row still pins; that read filters and pages by
-- (harness_session_id, execution_call_id_hash) once per Session load, over a
-- ledger that only ever grows.
CREATE INDEX idx_tool_execution_harness
    ON qwen_tool_execution (harness_session_id, execution_call_id_hash);
