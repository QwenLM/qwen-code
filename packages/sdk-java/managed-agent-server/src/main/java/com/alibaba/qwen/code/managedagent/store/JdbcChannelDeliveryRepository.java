package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * JDBC ledger of the H5 channel delivery outbox. Times are the database
 * clock's epoch milliseconds, the store's convention, so gmt_create and
 * gmt_modified never depend on an application host's clock.
 */
public final class JdbcChannelDeliveryRepository
        implements ChannelDeliveryRepository {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String COLUMNS = String.join(", ",
            "tenant_id", "channel_id AS channel_instance_id", "delivery_id", "segment_id",
            "segment_ordinal", "transport_state AS state", "provider_receipt_json", "gmt_create",
            "gmt_modified");
    private static final RowMapper<ChannelDelivery> MAPPER = (row, index) ->
            new ChannelDelivery(
                    row.getString("tenant_id"),
                    row.getString("channel_instance_id"),
                    row.getString("delivery_id"),
                    row.getString("segment_id"),
                    row.getInt("segment_ordinal"),
                    row.getString("state"),
                    receipt(row.getString("provider_receipt_json")),
                    row.getLong("gmt_create"),
                    row.getLong("gmt_modified"));

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
            jdbc.update("INSERT INTO ma_delivery (delivery_key, delivery_kind, source_scope_key,"
                            + " tenant_id, channel_id, delivery_id, segment_id, segment_ordinal,"
                            + " transport_state, reception_state, consumption_state, provider_receipt_json,"
                            + " payload_json, gmt_create, gmt_modified)"
                            + " VALUES (?, 'CHANNEL', ?, ?, ?, ?, ?, ?, ?, 'NOT_APPLICABLE',"
                            + " 'NOT_APPLICABLE', ?, '{\"schemaVersion\":1}', ?, ?)",
                    deliveryKey(candidate.tenantId(), candidate.channelInstanceId(), candidate.deliveryId()),
                    channelScope(candidate.tenantId(), candidate.channelInstanceId()),
                    candidate.tenantId(), candidate.channelInstanceId(), candidate.deliveryId(),
                    candidate.segmentId(), candidate.ordinal(), candidate.state(),
                    receiptJson(candidate.providerReceipt()), now, now);
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
                        + " FROM ma_delivery"
                        + " WHERE delivery_kind = 'CHANNEL' AND source_scope_key = ?"
                        + " AND tenant_id = ? AND channel_id = ?"
                        + " AND delivery_id = ?",
                MAPPER, channelScope(tenantId, channelInstanceId), tenantId, channelInstanceId, deliveryId).stream()
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
        List<Long> generations = jdbc.queryForList("SELECT claim_generation FROM ma_delivery"
                        + " WHERE delivery_key = ? AND delivery_kind = 'CHANNEL' AND tenant_id = ?"
                        + " AND channel_id = ? AND delivery_id = ?",
                Long.class, deliveryKey(tenantId, channelInstanceId, deliveryId), tenantId,
                channelInstanceId, deliveryId);
        if (generations.isEmpty()) {
            return null;
        }
        return transition(tenantId, channelInstanceId, deliveryId, expectedState, state,
                providerReceipt, generations.getFirst());
    }

    @Override
    public ChannelDelivery transition(String tenantId, String channelInstanceId, String deliveryId,
            String expectedState, String state, String providerReceipt, long claimGeneration) {
        if (!ChannelDeliveryRepository.isLegalStep(expectedState, state)) {
            throw new IllegalArgumentException("channel delivery cannot step " + expectedState + " -> " + state);
        }
        int updated = jdbc.update("UPDATE ma_delivery SET transport_state = ?,"
                        + " provider_receipt_json = COALESCE(?, provider_receipt_json), gmt_modified = ?"
                        + " WHERE delivery_key = ? AND delivery_kind = 'CHANNEL' AND tenant_id = ?"
                        + " AND channel_id = ? AND delivery_id = ? AND transport_state = ?"
                        + " AND claim_generation = ?",
                state, receiptJson(providerReceipt), databaseNow(),
                deliveryKey(tenantId, channelInstanceId, deliveryId), tenantId,
                channelInstanceId, deliveryId, expectedState, claimGeneration);
        Optional<ChannelDelivery> current = find(tenantId, channelInstanceId,
                deliveryId);
        if (updated == 1) {
            return current.orElseThrow(() -> new IllegalStateException(
                    "channel delivery transition left no row"));
        }
        Long actualGeneration = jdbc.queryForObject("SELECT claim_generation FROM ma_delivery WHERE delivery_key = ?",
                Long.class, deliveryKey(tenantId, channelInstanceId, deliveryId));
        if (actualGeneration == null || actualGeneration != claimGeneration) {
            return null;
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
        arguments.add(channelScope(tenantId, channelInstanceId));
        arguments.add(tenantId);
        arguments.add(channelInstanceId);
        String cursor = "";
        if (before != null) {
            cursor = " AND (gmt_create < ? OR gmt_create = ?"
                    + " AND delivery_id < ?)";
            arguments.add(before.createdAt());
            arguments.add(before.createdAt());
            arguments.add(before.deliveryId());
        }
        arguments.add(limit + 1);
        List<ChannelDelivery> rows = jdbc.query("SELECT " + COLUMNS
                        + " FROM ma_delivery"
                        + " WHERE delivery_kind = 'CHANNEL' AND source_scope_key = ?"
                        + " AND tenant_id = ? AND channel_id = ?" + cursor
                        + " ORDER BY gmt_create DESC, delivery_id DESC LIMIT ?",
                MAPPER, arguments.toArray());
        boolean hasMore = rows.size() > limit;
        return new DeliveryPage(hasMore ? rows.subList(0, limit) : rows,
                hasMore);
    }

    static String channelScope(String tenantId, String channelId) {
        return ManagedSchemaKeys.key(tenantId, channelId);
    }

    static String deliveryKey(String tenantId, String channelId, String deliveryId) {
        return ManagedSchemaKeys.key("CHANNEL", channelScope(tenantId, channelId), deliveryId);
    }

    private static String receiptJson(String receipt) {
        if (receipt == null) {
            return null;
        }
        try {
            return JSON.writeValueAsString(receipt);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Provider receipt cannot be encoded", exception);
        }
    }

    private static String receipt(String encoded) {
        if (encoded == null) {
            return null;
        }
        try {
            var receipt = JSON.readTree(encoded);
            if (!receipt.isTextual()) {
                throw new IllegalStateException("Channel provider receipt is not a string");
            }
            return receipt.textValue();
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Channel provider receipt is invalid", exception);
        }
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
