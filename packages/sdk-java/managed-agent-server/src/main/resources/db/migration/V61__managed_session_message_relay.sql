-- H4d-b of #12827: the session message relay's own ledger, one row per
-- outbox entry it claimed. A sender's outbound record stays the delivery
-- truth; the row holds the claim lease, the backoff and the durable
-- classifications (orphaned, unknown) that outlive the worker and must
-- never re-present as delivered or re-deliver. The discovery scan reuses
-- V54's (domain, delivery_state) index on the extension records.
CREATE TABLE qwen_managed_session_message_relay (
    tenant_id VARCHAR(128) NOT NULL,
    sender_session_id VARCHAR(64) NOT NULL,
    message_id VARCHAR(512) NOT NULL,
    target_session_id VARCHAR(64),
    state VARCHAR(24) NOT NULL,
    claimed_by VARCHAR(128),
    claimed_until BIGINT,
    attempts INT NOT NULL DEFAULT 0,
    next_retry_at BIGINT NOT NULL DEFAULT 0,
    last_error VARCHAR(1024),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (sender_session_id, message_id),
    INDEX idx_session_message_relay_poll (state, next_retry_at)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
