-- H6b/H6c of #12827: the control plane's automation ledgers. None of these
-- holds a journal fact: the Session journal's schedule and automation_run
-- chains stay the authority; these rows mirror the scanner's view of a
-- definition, lease it to one scanner at a time, remember every occurrence
-- decision, and replay public mutations by their Idempotency-Key.

-- One row per definition: the latest revision as the scanner reads it
-- (refreshed from the record when the mirrored revision lags), the arming
-- instant and covered watermark the slot window derives from, and the
-- lease with its fence. A scanner that lost the lease cannot move the
-- watermark or record occurrences: every write names the fence it holds.
CREATE TABLE qwen_managed_automation_schedule (
    tenant_id VARCHAR(128) NOT NULL,
    schedule_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    actor_id VARCHAR(512) NOT NULL,
    record_revision BIGINT NOT NULL,
    definition_revision BIGINT NOT NULL,
    definition_digest CHAR(64) NOT NULL,
    goal VARCHAR(4096) NOT NULL,
    cron VARCHAR(400) NOT NULL,
    timezone VARCHAR(256) NOT NULL,
    session_mode VARCHAR(16) NOT NULL,
    overlap VARCHAR(16) NOT NULL,
    catch_up VARCHAR(16) NOT NULL,
    catch_up_limit BIGINT NULL,
    enabled BOOLEAN NOT NULL,
    state VARCHAR(16) NOT NULL,
    blocked_reason VARCHAR(1024) NULL,
    armed_at BIGINT NOT NULL,
    watermark_slot BIGINT NULL,
    lease_owner VARCHAR(128) NULL,
    lease_until BIGINT NULL,
    fence BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, schedule_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_managed_automation_schedule_scan
    ON qwen_managed_automation_schedule (state, enabled, lease_until);
CREATE INDEX idx_managed_automation_schedule_list
    ON qwen_managed_automation_schedule (tenant_id, created_at, schedule_id);
CREATE INDEX idx_managed_automation_schedule_session
    ON qwen_managed_automation_schedule (tenant_id, session_id);

-- One row per occurrence decision of a definition. The run id is the
-- derivation of the definition and the occurrence, so it is known before
-- the Harness answers; `firing` marks a claim whose answer has not been
-- recorded and is re-driven by later scans with bounded backoff, `fired` a
-- committed run, `skipped` and `missed` decisions that never produced a
-- run, and `unknown` a claim whose answer stayed unobtainable past the
-- retry bound — visible, never re-driven. Every row is written under the
-- definition's lease: the insert and each settle name the holder's fence.
CREATE TABLE qwen_managed_automation_occurrence (
    tenant_id VARCHAR(128) NOT NULL,
    schedule_id VARCHAR(128) NOT NULL,
    occurrence_key VARCHAR(160) NOT NULL,
    run_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    slot BIGINT NULL,
    trigger_kind VARCHAR(16) NOT NULL,
    outcome VARCHAR(16) NOT NULL,
    reason VARCHAR(64) NULL,
    definition_revision BIGINT NOT NULL,
    fence BIGINT NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    next_retry_at BIGINT NOT NULL DEFAULT 0,
    last_error VARCHAR(1024) NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, schedule_id, occurrence_key)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_managed_automation_occurrence_list
    ON qwen_managed_automation_occurrence (
        tenant_id, schedule_id, created_at, occurrence_key
    );
CREATE INDEX idx_managed_automation_occurrence_outcome
    ON qwen_managed_automation_occurrence (tenant_id, schedule_id, outcome);

-- Public mutations replay by Idempotency-Key: the recorded answer is
-- returned for the same request digest, a different digest is a conflict.
CREATE TABLE qwen_managed_automation_command (
    tenant_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    actor_id VARCHAR(512) NOT NULL,
    request_digest VARCHAR(80) NOT NULL,
    schedule_id VARCHAR(128) NOT NULL,
    result_json LONGTEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, idempotency_key)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
