-- H5b/H5c of #12827: the registered channel connections, the route
-- catalog that maps an authenticated scope to its Session, and the
-- dispatcher's claim ledger that remembers which Session a claimed delivery
-- belongs to and when it was claimed. None of these holds a journal fact:
-- the Session journal's channel_route and channel_delivery chains stay the
-- authority; these rows locate, index and lease.

CREATE TABLE qwen_managed_channel_instance (
    tenant_id VARCHAR(128) NOT NULL,
    channel_id VARCHAR(128) NOT NULL,
    platform VARCHAR(64) NOT NULL,
    account_id VARCHAR(512) NOT NULL,
    account_generation BIGINT NOT NULL,
    state VARCHAR(16) NOT NULL,
    actor_id VARCHAR(512) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    cwd_relative VARCHAR(1024) NOT NULL,
    policy_json LONGTEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, channel_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_managed_channel_instance_created
    ON qwen_managed_channel_instance (tenant_id, created_at, channel_id);

-- One row per route chain: the scope the Session journal keyed the chain
-- by, so the next event on that scope finds its Session without guessing.
CREATE TABLE qwen_managed_channel_binding (
    tenant_id VARCHAR(128) NOT NULL,
    channel_id VARCHAR(128) NOT NULL,
    route_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    scope_kind VARCHAR(16) NOT NULL,
    sender_id VARCHAR(512),
    chat_id VARCHAR(512),
    thread_id VARCHAR(512),
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, channel_id, route_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_managed_channel_binding_session
    ON qwen_managed_channel_binding (tenant_id, session_id);

-- The claim of one delivery: the Session its record lives in and the
-- time the dispatcher claimed it, so an adapter that dies after a send
-- is settled unknown by lease, never resent.
CREATE TABLE qwen_managed_channel_claim (
    tenant_id VARCHAR(128) NOT NULL,
    channel_id VARCHAR(128) NOT NULL,
    delivery_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    claimed_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, channel_id, delivery_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_managed_channel_claim_claimed
    ON qwen_managed_channel_claim (tenant_id, channel_id, claimed_at);
