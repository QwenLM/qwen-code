-- H5 channel ingress route bindings: one row per (channel instance, account
-- generation, platform event, semantic revision) that an authenticated
-- channel instance routed to a Session, with the attachments still staged
-- for admission. Two physically distinct platform events stay two rows even
-- when their text is identical. route_key hashes the binding identity; the
-- identity columns stay separate for queries and audits.
CREATE TABLE qwen_managed_channel_route (
    tenant_id VARCHAR(128) NOT NULL,
    route_key CHAR(64) NOT NULL,
    channel_instance_id VARCHAR(128) NOT NULL,
    account_generation BIGINT NOT NULL,
    platform_event_id VARCHAR(512) NOT NULL,
    semantic_revision BIGINT NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    sender_id VARCHAR(512) NOT NULL,
    chat_id VARCHAR(512),
    thread_id VARCHAR(512),
    state VARCHAR(16) NOT NULL,
    input_id VARCHAR(512),
    staged_attachment_refs_json LONGTEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, route_key)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_managed_channel_route_channel
    ON qwen_managed_channel_route (
        tenant_id, channel_instance_id, created_at, route_key
    );

-- H5 channel deliveries: one row per deliveryId of a channel's outbox, with
-- the stable segment it carries, the provider receipt once returned and a
-- state line that keeps partial and unknown outcomes first-class. An
-- explicit resend is a new deliveryId for the same segment.
CREATE TABLE qwen_managed_channel_delivery (
    tenant_id VARCHAR(128) NOT NULL,
    channel_instance_id VARCHAR(128) NOT NULL,
    delivery_id VARCHAR(128) NOT NULL,
    segment_id VARCHAR(128) NOT NULL,
    segment_ordinal INT NOT NULL,
    state VARCHAR(16) NOT NULL,
    provider_receipt VARCHAR(512),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, channel_instance_id, delivery_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_managed_channel_delivery_created
    ON qwen_managed_channel_delivery (
        tenant_id, channel_instance_id, created_at, delivery_id
    );

CREATE INDEX idx_managed_channel_delivery_segment
    ON qwen_managed_channel_delivery (
        tenant_id, channel_instance_id, segment_id, segment_ordinal
    );
