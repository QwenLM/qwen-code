package com.alibaba.qwen.code.managedagent.store;

import java.util.List;
import java.util.Optional;

/**
 * Persistence boundary for the H5 channel delivery outbox
 * (qwen_managed_channel_delivery). One row per deliveryId; a streaming card
 * or segmented reply keeps a stable segment identity and ordinal, and an
 * explicit resend is a new deliveryId for the same segment.
 */
public interface ChannelDeliveryRepository {
    /**
     * The delivery states of a channel-target outbox line, the channel
     * subset of the shared delivery line: partial and unknown are
     * first-class outcomes, never collapsed into delivered.
     */
    List<String> DELIVERY_STATES = List.of("planned", "sending", "partial",
            "delivered", "unknown", "rejected", "cancelled");

    /** One outbound delivery. */
    record ChannelDelivery(
            String tenantId,
            String channelInstanceId,
            String deliveryId,
            String segmentId,
            int ordinal,
            String state,
            String providerReceipt,
            long createdAt,
            long updatedAt) {
    }

    /** Exclusive page cursor: created time and delivery id of the last row. */
    record DeliveryCursor(long createdAt, String deliveryId) {
    }

    /** One newest-first page of deliveries. */
    record DeliveryPage(List<ChannelDelivery> deliveries, boolean hasMore) {
    }

    /**
     * Whether the shared delivery line allows one step from {@code from} to
     * {@code to} for a channel target.
     */
    static boolean isLegalStep(String from, String to) {
        return DELIVERY_STATES.contains(to)
                && ManagedExtensionRecords.TRANSITIONS.get("delivery")
                        .getOrDefault(from, List.of()).contains(to);
    }

    /**
     * Inserts the candidate, which must start {@code planned}, or returns
     * the row its deliveryId already committed. A duplicate id bound to
     * another segment fails instead of silently joining it.
     */
    ChannelDelivery findOrCreate(ChannelDelivery candidate);

    Optional<ChannelDelivery> find(String tenantId, String channelInstanceId,
            String deliveryId);

    /**
     * Moves a delivery one legal step of the channel delivery line,
     * atomically checked against the stored state. A non-null receipt
     * overwrites the stored provider receipt. Returns the updated row, or,
     * when the row already holds {@code state} with a matching receipt, the
     * current row as the idempotent replay of this step; null when the row
     * is absent or holds any other state.
     */
    ChannelDelivery transition(String tenantId, String channelInstanceId,
            String deliveryId, String expectedState, String state,
            String providerReceipt);

    /**
     * Newest first by (createdAt, deliveryId) descending; {@code before}
     * excludes its own row. {@code limit} must be in [1, 100].
     */
    DeliveryPage listByChannel(String tenantId, String channelInstanceId,
            DeliveryCursor before, int limit);
}
