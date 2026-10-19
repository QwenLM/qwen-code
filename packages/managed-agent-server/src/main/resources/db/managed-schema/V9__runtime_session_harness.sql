-- Session close releases one Harness Session's Runtime Sessions across shared bindings.
CREATE INDEX ix_ma_runtime_session_harness ON ma_runtime_session (harness_session_id);
