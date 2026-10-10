-- The terminal retry budget of a lifecycle operation counts only attempts
-- that could have made progress. An attempt that waited on an external
-- condition — a live journal writer, or Java's stale view of a restarted
-- Harness — records the attempt count it reached here instead of consuming
-- the budget, so an operation that waited out the condition still gets the
-- full budget for its own failures.
ALTER TABLE managed_agent_operation
    ADD COLUMN budget_exempt_attempt INT NOT NULL DEFAULT 0;

-- The column debuts at 0, but every row already in flight accumulated its
-- attempt_count under the previous regime, which had no terminal budget at
-- all: none of those attempts was ever classified against a budget, so
-- charging them now would terminate a long-retrying operation on its first
-- post-upgrade failure. A one-time backfill marks every in-flight row's
-- existing attempts exempt, giving each a full budget under the new regime.
-- This is the only place the two columns may be set equal: after the
-- upgrade the exempt count increments from itself, never from
-- attempt_count. ACTION_RESPONSE rows are excluded — for them a nonzero
-- watermark is the durable "the Harness already answered" latch
-- (ActionResponseCoordinator), not a budget fact.
UPDATE managed_agent_operation
    SET budget_exempt_attempt = attempt_count
    WHERE operation_kind <> 'ACTION_RESPONSE'
        AND state IN ('PENDING', 'RUNNING', 'RECOVERY_BLOCKED');

-- The Turn retry budget splits off the pacing counter: retry_count stays
-- the monotone exponent of the dispatch backoff, while
-- consecutive_failures is the counter the terminal budget reads. Journaled
-- progress (an admission, a recovery admission, or new events) zeroes only
-- consecutive_failures, so a crash loop that keeps making progress still
-- converges to the terminal arm while its backoff keeps growing. Rows in
-- flight at upgrade time start at 0 — a full budget under the new regime,
-- the same grace the operation backfill above grants.
ALTER TABLE managed_agent_turn
    ADD COLUMN consecutive_failures INT NOT NULL DEFAULT 0;
