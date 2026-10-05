-- The terminal retry budget of a lifecycle operation counts only attempts
-- that could have made progress. An attempt that waited on an external
-- condition — a live journal writer, or Java's stale view of a restarted
-- Harness — records the attempt count it reached here instead of consuming
-- the budget, so an operation that waited out the condition still gets the
-- full budget for its own failures.
ALTER TABLE managed_agent_operation
    ADD COLUMN budget_exempt_attempt INT NOT NULL DEFAULT 0;
