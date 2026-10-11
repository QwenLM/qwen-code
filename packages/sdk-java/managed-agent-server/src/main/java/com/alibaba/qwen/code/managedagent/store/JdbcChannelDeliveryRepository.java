package com.alibaba.qwen.code.managedagent.store;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

/**
 * JDBC ledger of the H5 channel delivery outbox. Times are the database
 * clock's epoch milliseconds, the store's convention, so created_at and
 * updated_at never depend on an application host's clock.
 */
public final class JdbcChannelDeliveryRepository
        implements ChannelDeliveryRepository {
    private static final String COLUMNS = String.join(", ",
            "tenant_id", "channel_instance_id", "delivery_id", "segment_id",
            "segment_ordinal", "state", "provider_receipt", "created_at",
            "updated_at");
    private static final RowMapper<ChannelDelivery> MAPPER = (row, index) ->
            new ChannelDelivery(
                    row.getString("tenant_id"),
                    row.getString("channel_instance_id"),
                    row.getString("delivery_id"),
                    row.getString("segment_id"),
                    row.getInt("segment_ordinal"),
                    row.getString("state"),
                    row.getString("provider_receipt"),
                    row.getLong("created_at"),
                    row.getLong("updated_at"));

    private final JdbcTemplate jdbc;

    public JdbcChannelDeliveryRepository(JdbcTemplate jdbc) {
        if (jdbc == null) {
            throw new IllegalArgumentException("jdbc is required");
        }
        this.jdbc = jdbc;
    }

    @Override
    public ChannelDelivery findOrCreate(ChannelDelivery candidate) {
        requireCandidate(candidate);
        try {
            long now = databaseNow();
            jdbc.update("INSERT INTO qwen_managed_channel_delivery (" + COLUMNS
                            + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    candidate.tenantId(),
                    candidate.channelInstanceId(),
                    candidate.deliveryId(),
                    candidate.segmentId(),
                    candidate.ordinal(),
                    candidate.state(),
                    candidate.providerReceipt(),
                    now, now);
        } catch (DuplicateKeyException duplicate) {
            // A retried create of one delivery: keep the first row.
        }
        Optional<ChannelDelivery> stored = find(candidate.tenantId(),
                candidate.channelInstanceId(), candidate.deliveryId());
        ChannelDelivery row = stored.orElseThrow(() -> new IllegalStateException(
                "channel delivery insert left no row"));
        if (!row.channelInstanceId().equals(candidate.channelInstanceId())
                || !row.segmentId().equals(candidate.segmentId())
                || row.ordinal() != candidate.ordinal()) {
            throw new IllegalStateException(
                    "delivery id already belongs to another segment");
        }
        return row;
    }

    @Override
    public Optional<ChannelDelivery> find(String tenantId,
            String channelInstanceId, String deliveryId) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(channelInstanceId, "channelInstanceId");
        ChannelStoreSupport.requireId(deliveryId, "deliveryId");
        return jdbc.query("SELECT " + COLUMNS
                        + " FROM qwen_managed_channel_delivery"
                        + " WHERE tenant_id = ? AND channel_instance_id = ?"
                        + " AND delivery_id = ?",
                MAPPER, tenantId, channelInstanceId, deliveryId).stream()
                .findFirst();
    }

    @Override
    public ChannelDelivery transition(String tenantId,
            String channelInstanceId, String deliveryId,
            String expectedState, String state, String providerReceipt) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(channelInstanceId, "channelInstanceId");
        ChannelStoreSupport.requireId(deliveryId, "deliveryId");
        ChannelStoreSupport.requireId(expectedState, "expectedState");
        ChannelStoreSupport.requireId(state, "state");
        if (!ChannelDeliveryRepository.isLegalStep(expectedState, state)) {
            throw new IllegalArgumentException("channel delivery cannot step "
                    + expectedState + " -> " + state);
        }
        int updated = jdbc.update("UPDATE qwen_managed_channel_delivery SET"
                        + " state = ?, provider_receipt = COALESCE(?,"
                        + " provider_receipt), updated_at = ?"
                        + " WHERE tenant_id = ? AND channel_instance_id = ?"
                        + " AND delivery_id = ? AND state = ?",
                state, providerReceipt, databaseNow(), tenantId,
                channelInstanceId, deliveryId, expectedState);
        Optional<ChannelDelivery> current = find(tenantId, channelInstanceId,
                deliveryId);
        if (updated == 1) {
            return current.orElseThrow(() -> new IllegalStateException(
                    "channel delivery transition left no row"));
        }
        return current.filter(row -> state.equals(row.state())
                && (providerReceipt == null || providerReceipt.equals(
                        row.providerReceipt()))).orElse(null);
    }

    @Override
    public DeliveryPage listByChannel(String tenantId,
            String channelInstanceId, DeliveryCursor before, int limit) {
        ChannelStoreSupport.requireId(tenantId, "tenantId");
        ChannelStoreSupport.requireId(channelInstanceId, "channelInstanceId");
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("limit must be in [1, 100]");
        }
        List<Object> arguments = new ArrayList<>();
        arguments.add(tenantId);
        arguments.add(channelInstanceId);
        String cursor = "";
        if (before != null) {
            cursor = " AND (created_at < ? OR created_at = ?"
                    + " AND delivery_id < ?)";
            arguments.add(before.createdAt());
            arguments.add(before.createdAt());
            arguments.add(before.deliveryId());
        }
        arguments.add(limit + 1);
        List<ChannelDelivery> rows = jdbc.query("SELECT " + COLUMNS
                        + " FROM qwen_managed_channel_delivery"
                        + " WHERE tenant_id = ? AND channel_instance_id = ?" + cursor
                        + " ORDER BY created_at DESC, delivery_id DESC LIMIT ?",
                MAPPER, arguments.toArray());
        boolean hasMore = rows.size() > limit;
        return new DeliveryPage(hasMore ? rows.subList(0, limit) : rows,
                hasMore);
    }

    private long databaseNow() {
        return jdbc.queryForObject(
                "SELECT UNIX_TIMESTAMP(),"
                        + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> Math.addExact(
                        Math.multiplyExact(row.getLong(1), 1000),
                        row.getLong(2) / 1000));
    }

    private static void requireCandidate(ChannelDelivery candidate) {
        if (candidate == null) {
            throw new IllegalArgumentException("candidate is required");
        }
        ChannelStoreSupport.requireId(candidate.tenantId(), "tenantId");
        ChannelStoreSupport.requireId(candidate.channelInstanceId(),
                "channelInstanceId");
        ChannelStoreSupport.requireId(candidate.deliveryId(), "deliveryId");
        ChannelStoreSupport.requireId(candidate.segmentId(), "segmentId");
        if (candidate.ordinal() < 0) {
            throw new IllegalArgumentException("ordinal must not be negative");
        }
        if (!"planned".equals(candidate.state())) {
            throw new IllegalArgumentException(
                    "a new delivery starts planned, not " + candidate.state());
        }
    }
}
