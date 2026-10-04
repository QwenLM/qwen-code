-- The materializer's target scan reads this marker instead of probing the
-- snapshot row of every caught-up session on every tick: a deferred snapshot
-- rewrite records the snapshot's updated_at here, and the disjunct selects
-- the session once that snapshot is SNAPSHOT_REFRESH_MILLIS old.
ALTER TABLE managed_agent_consumer_progress
    ADD COLUMN snapshot_stale_since BIGINT;
