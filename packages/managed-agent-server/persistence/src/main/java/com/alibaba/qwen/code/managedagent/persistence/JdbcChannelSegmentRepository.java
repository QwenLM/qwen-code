package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelSegmentRepository;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelStoreSupport;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.util.List;

/**
 * JDBC ledger of a CHANNEL delivery's segments. Times are the database
 * clock's epoch milliseconds, the store's convention. A segment's provider
 * receipt is written once: the receipt update only touches a row whose
 * receipt is still null, so a replay or a racing second receipt is a no-op.
 */
public final class JdbcChannelSegmentRepository
        implements ChannelSegmentRepository {
    private static final RowMapper<SegmentLedger> MAPPER = (row, index) ->
            new SegmentLedger(row.getString("segment_id"),
                    row.getInt("segment_ordinal"),
                    JdbcChannelDeliveryRepository.receipt(
                            row.getString("provider_receipt_json")));

    private final JdbcTemplate jdbc;

    public JdbcChannelSegmentRepository(JdbcTemplate jdbc) {
        if (jdbc == null) {
            throw new IllegalArgumentException("jdbc is required");
        }
        this.jdbc = jdbc;
    }

    @Override
    public void plan(String tenantId, String channelInstanceId,
            String deliveryId, List<SegmentLedger> segments) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(channelInstanceId, "channelInstanceId");
        ChannelStoreSupport.requireId(deliveryId, "deliveryId");
        String key = JdbcChannelDeliveryRepository.deliveryKey(tenantId,
                channelInstanceId, deliveryId);
        long now = databaseNow();
        for (SegmentLedger segment : segments) {
            ChannelStoreSupport.requireId(segment.segmentId(), "segmentId");
            if (segment.ordinal() < 0) {
                throw new IllegalArgumentException("ordinal must not be negative");
            }
            jdbc.update("INSERT IGNORE INTO ma_channel_segment (delivery_key,"
                            + " tenant_id, channel_id, segment_id, segment_ordinal,"
                            + " provider_receipt_json, gmt_create, gmt_modified)"
                            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    key, tenantId, channelInstanceId, segment.segmentId(),
                    segment.ordinal(),
                    JdbcChannelDeliveryRepository.receiptJson(
                            segment.providerReceipt()),
                    now, now);
        }
    }

    @Override
    public boolean receipt(String tenantId, String channelInstanceId,
            String deliveryId, int ordinal, String providerReceipt) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(channelInstanceId, "channelInstanceId");
        ChannelStoreSupport.requireId(deliveryId, "deliveryId");
        ChannelStoreSupport.requireId(providerReceipt, "providerReceipt");
        if (ordinal < 0) {
            throw new IllegalArgumentException("ordinal must not be negative");
        }
        String key = JdbcChannelDeliveryRepository.deliveryKey(tenantId,
                channelInstanceId, deliveryId);
        return jdbc.update("UPDATE ma_channel_segment SET provider_receipt_json = ?,"
                        + " gmt_modified = ? WHERE delivery_key = ?"
                        + " AND segment_ordinal = ? AND provider_receipt_json IS NULL",
                JdbcChannelDeliveryRepository.receiptJson(providerReceipt),
                databaseNow(), key, ordinal) == 1;
    }

    @Override
    public List<SegmentLedger> list(String tenantId, String channelInstanceId,
            String deliveryId) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(channelInstanceId, "channelInstanceId");
        ChannelStoreSupport.requireId(deliveryId, "deliveryId");
        String key = JdbcChannelDeliveryRepository.deliveryKey(tenantId,
                channelInstanceId, deliveryId);
        return jdbc.query("SELECT segment_id, segment_ordinal, provider_receipt_json"
                        + " FROM ma_channel_segment WHERE delivery_key = ?"
                        + " ORDER BY segment_ordinal",
                MAPPER, key);
    }

    private long databaseNow() {
        return jdbc.queryForObject(
                "SELECT UNIX_TIMESTAMP(),"
                        + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> Math.addExact(
                        Math.multiplyExact(row.getLong(1), 1000),
                        row.getLong(2) / 1000));
    }
}
