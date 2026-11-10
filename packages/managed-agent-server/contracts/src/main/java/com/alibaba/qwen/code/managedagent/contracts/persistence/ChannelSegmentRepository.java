package com.alibaba.qwen.code.managedagent.contracts.persistence;

import java.util.List;

/**
 * Persistence boundary for the per-segment ledger of a CHANNEL delivery
 * (ma_channel_segment). One row per (deliveryKey, segmentId); the provider
 * receipt is written once per segment and never rewritten. The delivery-level
 * state line stays on ma_delivery; this table holds the segment identities and
 * receipts that recovery converges and a later public projection reads.
 */
public interface ChannelSegmentRepository {
    /** One segment of a delivery: its stable identity, ordinal, and receipt. */
    public record SegmentLedger(String segmentId, int ordinal,
            String providerReceipt) {
    }

    /**
     * Idempotently inserts the segment plan. Existing rows are never
     * overwritten, so a resumed partial keeps the receipts it already holds.
     */
    public void plan(String tenantId, String channelInstanceId, String deliveryId,
            List<SegmentLedger> segments);

    /**
     * Writes the provider receipt for one segment once. Returns true when this
     * call stored the receipt; false when the segment already holds a receipt
     * (a replay or a conflict), which is left intact.
     */
    public boolean receipt(String tenantId, String channelInstanceId,
            String deliveryId, int ordinal, String providerReceipt);

    /** The delivery's segments ordered by ordinal. */
    public List<SegmentLedger> list(String tenantId, String channelInstanceId,
            String deliveryId);
}
