package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelSegmentRepository;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelStoreSupport;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import org.springframework.jdbc.core.BatchPreparedStatementSetter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
        for (SegmentLedger segment : segments) {
            ChannelStoreSupport.requireId(segment.segmentId(), "segmentId");
            if (segment.ordinal() < 0) {
                throw new IllegalArgumentException("ordinal must not be negative");
            }
        }
        if (segments.isEmpty()) {
            return;
        }
        long now = databaseNow();
        // One batched INSERT IGNORE for the whole plan: a single
        // PreparedStatement + executeBatch instead of a per-segment statement
        // construction at the 64-segment bound (#16818 B). Cutting wire round
        // trips as well would need the driver's rewriteBatchedStatements.
        int[] inserted = jdbc.batchUpdate(
                "INSERT IGNORE INTO ma_channel_segment (delivery_id,"
                        + " tenant_id, channel_id, segment_id, segment_ordinal,"
                        + " provider_receipt_json, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                new BatchPreparedStatementSetter() {
                    @Override
                    public void setValues(PreparedStatement statement, int index)
                            throws SQLException {
                        SegmentLedger segment = segments.get(index);
                        statement.setString(1, deliveryId);
                        statement.setString(2, tenantId);
                        statement.setString(3, channelInstanceId);
                        statement.setString(4, segment.segmentId());
                        statement.setInt(5, segment.ordinal());
                        statement.setString(6, JdbcChannelDeliveryRepository
                                .receiptJson(segment.providerReceipt()));
                        statement.setLong(7, now);
                        statement.setLong(8, now);
                    }

                    @Override
                    public int getBatchSize() {
                        return segments.size();
                    }
                });
        // A row the insert just created already carries its receipt; only a
        // pre-existing row (insert ignored, count 0) needs the write-once
        // backfill. A driver that reports no per-row count (SUCCESS_NO_INFO)
        // also takes the guarded update, a no-op on a row already receipted.
        // Batch the backfill like the insert: one guarded UPDATE batch rather
        // than a per-segment no-op UPDATE (#16818 B).
        List<SegmentLedger> backfill = new ArrayList<>();
        for (int index = 0; index < segments.size(); index++) {
            SegmentLedger segment = segments.get(index);
            if (segment.providerReceipt() != null && inserted[index] != 1) {
                backfill.add(segment);
            }
        }
        if (!backfill.isEmpty()) {
            jdbc.batchUpdate("UPDATE ma_channel_segment SET provider_receipt_json = ?,"
                            + " gmt_modified = ? WHERE delivery_id = ?"
                            + " AND tenant_id = ? AND channel_id = ?"
                            + " AND segment_ordinal = ? AND provider_receipt_json IS NULL",
                    backfill, backfill.size(),
                    (statement, segment) -> {
                        statement.setString(1, JdbcChannelDeliveryRepository
                                .receiptJson(segment.providerReceipt()));
                        statement.setLong(2, now);
                        statement.setString(3, deliveryId);
                        statement.setString(4, tenantId);
                        statement.setString(5, channelInstanceId);
                        statement.setInt(6, segment.ordinal());
                    });
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
        return receiptOnce(tenantId, channelInstanceId, deliveryId, ordinal,
                providerReceipt);
    }

    private boolean receiptOnce(String tenantId, String channelInstanceId,
            String deliveryId, int ordinal, String providerReceipt) {
        return receiptOnce(tenantId, channelInstanceId, deliveryId, ordinal,
                providerReceipt, databaseNow());
    }

    private boolean receiptOnce(String tenantId, String channelInstanceId,
            String deliveryId, int ordinal, String providerReceipt, long now) {
        return jdbc.update("UPDATE ma_channel_segment SET provider_receipt_json = ?,"
                        + " gmt_modified = ? WHERE delivery_id = ?"
                        + " AND tenant_id = ? AND channel_id = ?"
                        + " AND segment_ordinal = ? AND provider_receipt_json IS NULL",
                JdbcChannelDeliveryRepository.receiptJson(providerReceipt),
                now, deliveryId, tenantId,
                channelInstanceId, ordinal) == 1;
    }

    @Override
    public List<SegmentLedger> list(String tenantId, String channelInstanceId,
            String deliveryId) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(channelInstanceId, "channelInstanceId");
        ChannelStoreSupport.requireId(deliveryId, "deliveryId");
        return jdbc.query("SELECT segment_id, segment_ordinal, provider_receipt_json"
                        + " FROM ma_channel_segment WHERE delivery_id = ?"
                        + " AND tenant_id = ? AND channel_id = ?"
                        + " ORDER BY segment_ordinal",
                MAPPER, deliveryId, tenantId,
                channelInstanceId);
    }

    @Override
    public Map<String, List<SegmentLedger>> listByDelivery(String tenantId,
            String channelInstanceId, List<String> deliveryIds) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(channelInstanceId, "channelInstanceId");
        Map<String, List<SegmentLedger>> byDelivery = new LinkedHashMap<>();
        if (deliveryIds.isEmpty()) {
            return byDelivery;
        }
        for (String deliveryId : deliveryIds) {
            ChannelStoreSupport.requireId(deliveryId, "deliveryId");
            byDelivery.put(deliveryId, new ArrayList<>());
        }
        // One query for the whole page instead of a segment query per delivery
        // row (#16818 B). Every requested deliveryId keeps an entry, empty
        // when it holds no segments.
        String placeholders = String.join(",",
                Collections.nCopies(byDelivery.size(), "?"));
        List<Object> arguments = new ArrayList<>();
        for (String deliveryId : byDelivery.keySet()) {
            arguments.add(deliveryId);
        }
        arguments.add(tenantId);
        arguments.add(channelInstanceId);
        return jdbc.query("SELECT delivery_id, segment_id, segment_ordinal,"
                        + " provider_receipt_json FROM ma_channel_segment"
                        + " WHERE delivery_id IN (" + placeholders + ")"
                        + " AND tenant_id = ? AND channel_id = ?"
                        + " ORDER BY delivery_id, segment_ordinal",
                resultSet -> {
                    while (resultSet.next()) {
                        // The same mapper list uses, so the two read paths can
                        // never publish different segments for one delivery.
                        byDelivery.get(ManagedSchemaRows.identity(
                                resultSet, "delivery_id"))
                                .add(MAPPER.mapRow(resultSet, 0));
                    }
                    return byDelivery;
                },
                arguments.toArray());
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
