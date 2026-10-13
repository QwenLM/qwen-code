package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.BooleanSupplier;

/**
 * The Channel domain bodies (H5a of #12827): {@code managed-channel_route}
 * is the durable binding of one authenticated (instance, account, sender,
 * chat, thread) scope to one Session; {@code managed-channel_delivery} is
 * one formal result sent out through that binding, with one receipt per
 * segment. The shared fixtures in packages/core pin both validators, and
 * managed-channel-record.ts there replays the same cases. Both domains stay
 * disabled for submission until the slices that ship their producers.
 */
public final class ManagedChannelRecords {
    public static final int MAX_DELIVERY_SEGMENTS = 64;

    private static final Set<String> ROUTE_KEYS = Set.of("routeId",
            "channelInstanceId", "accountId", "accountGeneration",
            "routeRevision", "rootSessionId", "sessionId", "scope",
            "policyRef", "run");
    private static final Set<String> DELIVERY_KEYS = Set.of("deliveryId",
            "routeId", "routeRevision", "sourceTurnId", "contentRef",
            "segments", "cancelRequested", "run");
    private static final Set<String> SCOPE_KEYS = Set.of("kind", "senderId",
            "chatId", "threadId");
    private static final Set<String> SEGMENT_KEYS = Set.of("segmentId",
            "ordinal", "contentRef", "receipt");
    private static final Set<String> RECEIPT_KEYS = Set.of(
            "providerMessageId", "acceptedAt", "proofRef");
    /** The route fields a rebind revision may change, and only then. */
    private static final List<String> REBIND_KEYS = List.of(
            "accountGeneration", "routeRevision", "rootSessionId",
            "sessionId", "policyRef");

    private ManagedChannelRecords() {
    }

    /** Checks the body of a managed-channel_route domain record. */
    public static void requireRoute(JsonNode record) {
        ManagedExtensionRecords.closed(record, ROUTE_KEYS, "channelRoute");
        String routeId = ManagedExtensionRecords.id(record.get("routeId"),
                "channelRoute.routeId");
        ManagedExtensionRecords.id(record.get("channelInstanceId"),
                "channelInstanceId");
        ManagedExtensionRecords.id(record.get("accountId"), "accountId");
        ManagedExtensionRecords.count(record.get("accountGeneration"), 1,
                Long.MAX_VALUE, "accountGeneration");
        ManagedExtensionRecords.count(record.get("routeRevision"), 1,
                Long.MAX_VALUE, "routeRevision");
        ManagedExtensionRecords.id(record.get("rootSessionId"),
                "rootSessionId");
        ManagedExtensionRecords.id(record.get("sessionId"), "sessionId");
        requireScope(record.get("scope"));
        ManagedExtensionRecords.durableRef(record.get("policyRef"),
                "policyRef");
        JsonNode run = record.get("run");
        ManagedExtensionRecords.requireRun(run);
        require(run.get("definition").isNull()
                && run.get("executionCallId").isNull()
                && routeId.equals(run.get("effectId").textValue())
                && run.get("dispatchId").isNull()
                && run.get("deliveryId").isNull()
                && run.get("execution").isNull()
                && run.get("runtime").isNull()
                && run.get("delivery").isNull(),
                "Channel route run must identify its effect and nothing else");
    }

    private static void requireScope(JsonNode scope) {
        ManagedExtensionRecords.closed(scope, SCOPE_KEYS, "channelRoute.scope");
        String kind = scope.get("kind").textValue();
        String sender = nullableId(scope.get("senderId"), "scope.senderId");
        String chat = nullableId(scope.get("chatId"), "scope.chatId");
        String thread = nullableId(scope.get("threadId"), "scope.threadId");
        boolean carries = switch (kind == null ? "" : kind) {
            // The carriers the Legacy routing key derives per scope.
            case "user" -> sender != null && chat != null && thread == null;
            case "thread" -> sender == null && (chat == null) != (thread == null);
            case "chat_thread" -> sender == null && chat != null;
            case "single" -> sender == null && chat == null && thread == null;
            default -> false;
        };
        require(carries, "Channel route scope " + kind
                + " does not carry its identity");
    }

    /** Checks the body of a managed-channel_delivery domain record. */
    public static void requireDelivery(JsonNode record) {
        ManagedExtensionRecords.closed(record, DELIVERY_KEYS,
                "channelDelivery");
        String deliveryId = ManagedExtensionRecords.id(
                record.get("deliveryId"), "channelDelivery.deliveryId");
        ManagedExtensionRecords.id(record.get("routeId"), "routeId");
        ManagedExtensionRecords.count(record.get("routeRevision"), 1,
                Long.MAX_VALUE, "routeRevision");
        ManagedExtensionRecords.id(record.get("sourceTurnId"),
                "sourceTurnId");
        ManagedExtensionRecords.durableRef(record.get("contentRef"),
                "contentRef");
        require(record.get("cancelRequested").isBoolean(),
                "Channel delivery cancelRequested must be boolean");
        JsonNode segments = record.get("segments");
        require(segments.isArray() && !segments.isEmpty()
                && segments.size() <= MAX_DELIVERY_SEGMENTS,
                "Channel delivery segments must number 1 to "
                        + MAX_DELIVERY_SEGMENTS);
        Set<String> seen = new HashSet<>();
        int settled = 0;
        for (int index = 0; index < segments.size(); index++) {
            JsonNode segment = segments.get(index);
            ManagedExtensionRecords.closed(segment, SEGMENT_KEYS,
                    "channelDelivery.segments[" + index + "]");
            String segmentId = ManagedExtensionRecords.id(
                    segment.get("segmentId"), "segmentId");
            require(seen.add(segmentId), "Channel delivery segment "
                    + segmentId + " is named twice");
            require(ManagedExtensionRecords.count(segment.get("ordinal"), 0,
                    Long.MAX_VALUE, "ordinal") == index,
                    "Channel delivery segment ordinals must be dense from zero");
            ManagedExtensionRecords.durableRef(segment.get("contentRef"),
                    "contentRef");
            JsonNode receipt = segment.get("receipt");
            if (!receipt.isNull()) {
                ManagedExtensionRecords.closed(receipt, RECEIPT_KEYS,
                        "receipt");
                ManagedExtensionRecords.id(receipt.get("providerMessageId"),
                        "receipt.providerMessageId");
                ManagedExtensionRecords.count(receipt.get("acceptedAt"), 0,
                        ManagedExtensionRecords.MAX_TIME,
                        "receipt.acceptedAt");
                if (!receipt.get("proofRef").isNull()) {
                    ManagedExtensionRecords.durableRef(
                            receipt.get("proofRef"), "receipt.proofRef");
                }
                settled++;
            }
        }
        JsonNode run = record.get("run");
        ManagedExtensionRecords.requireRun(run);
        require(run.get("definition").isNull()
                && run.get("executionCallId").isNull()
                && deliveryId.equals(run.get("effectId").textValue())
                && run.get("dispatchId").isNull()
                && deliveryId.equals(run.get("deliveryId").textValue())
                && run.get("execution").isNull()
                && run.get("runtime").isNull()
                && !run.get("delivery").isNull()
                && "channel".equals(run.get("delivery").get("target")
                        .textValue()),
                "Channel delivery run must carry its channel delivery line "
                        + "and nothing else");
        String line = run.get("delivery").get("state").textValue();
        String state = run.get("state").textValue();
        String reason = run.get("reason").textValue();
        boolean inFlight = "running".equals(state) || "waiting".equals(state)
                || "recovery_blocked".equals(state);
        boolean pin = switch (line) {
            // A delivery exists only once it is planned; the run block
            // refuses a reserved state with a delivery.
            case "planned" -> "admitted".equals(state) && settled == 0;
            case "sending" -> inFlight && settled < segments.size();
            case "partial" -> inFlight && settled > 0
                    && settled < segments.size();
            case "delivered" -> "settled".equals(state)
                    && settled == segments.size();
            case "unknown" -> "waiting".equals(state) && reason == null
                    && settled < segments.size();
            case "rejected" -> "failed".equals(state)
                    && settled < segments.size();
            // A cancellation is always someone's committed act, so the
            // request flag is part of the cancelled fact.
            case "cancelled" -> "cancelled".equals(state) && settled == 0
                    && record.get("cancelRequested").booleanValue();
            default -> false;
        };
        require(pin, "Channel delivery line " + line
                + " does not match its run and segment receipts");
    }

    /** Whether {@code record} may be the first revision of a route. */
    public static boolean isRouteStart(JsonNode record) {
        return accepts(() -> {
            requireRoute(record);
            return ManagedExtensionRecords.isRunStart(record.get("run"));
        });
    }

    /**
     * Whether {@code record} may open a delivery: planned, without a cancel
     * request, and with no segment proven yet.
     */
    public static boolean isDeliveryStart(JsonNode record) {
        return accepts(() -> {
            requireDelivery(record);
            if (record.get("cancelRequested").booleanValue()) {
                return false;
            }
            for (JsonNode segment : record.get("segments")) {
                if (!segment.get("receipt").isNull()) {
                    return false;
                }
            }
            return ManagedExtensionRecords.isRunStart(record.get("run"));
        });
    }

    /**
     * Whether {@code next} may follow {@code previous} as the next revision
     * of one route: its identity and scope are fixed, its run moves
     * forward, and only a binding revision one higher than the last may
     * rebind — a rollover never moves the account generation backwards.
     */
    public static boolean isRouteSuccessor(JsonNode previous, JsonNode next) {
        return accepts(() -> {
            requireRoute(previous);
            requireRoute(next);
            if (!ManagedExtensionRecords.same(previous.get("routeId"),
                    next.get("routeId"))
                    || !ManagedExtensionRecords.same(previous.get("channelInstanceId"),
                            next.get("channelInstanceId"))
                    || !ManagedExtensionRecords.same(previous.get("accountId"),
                            next.get("accountId"))
                    || !ManagedExtensionRecords.same(previous.get("scope"),
                            next.get("scope"))
                    || !ManagedExtensionRecords.isRunSuccessor(
                            previous.get("run"), next.get("run"))) {
                return false;
            }
            if (ManagedExtensionRecords.TERMINAL.contains(
                    previous.get("run").get("state").textValue())) {
                return ManagedExtensionRecords.same(previous, next);
            }
            long before = previous.get("routeRevision").longValue();
            long after = next.get("routeRevision").longValue();
            if (before == after) {
                for (String key : REBIND_KEYS) {
                    if (!ManagedExtensionRecords.same(previous.get(key),
                            next.get(key))) {
                        return false;
                    }
                }
                return true;
            }
            return after == before + 1
                    && next.get("accountGeneration").longValue() >= previous
                            .get("accountGeneration").longValue();
        });
    }

    /**
     * Whether {@code next} may follow {@code previous} as the next revision
     * of one delivery: the plan and its pinned route revision are fixed,
     * each segment's receipt is set once and never rewritten, the cancel
     * request is never revoked, and an ended delivery changes nothing.
     */
    public static boolean isDeliverySuccessor(JsonNode previous,
            JsonNode next) {
        return accepts(() -> {
            requireDelivery(previous);
            requireDelivery(next);
            if (!ManagedExtensionRecords.same(previous.get("deliveryId"),
                    next.get("deliveryId"))
                    || !ManagedExtensionRecords.same(previous.get("routeId"),
                            next.get("routeId"))
                    || !ManagedExtensionRecords.same(previous.get("routeRevision"),
                            next.get("routeRevision"))
                    || !ManagedExtensionRecords.same(previous.get("sourceTurnId"),
                            next.get("sourceTurnId"))
                    || !ManagedExtensionRecords.same(previous.get("contentRef"),
                            next.get("contentRef"))) {
                return false;
            }
            JsonNode beforeSegments = previous.get("segments");
            JsonNode afterSegments = next.get("segments");
            if (beforeSegments.size() != afterSegments.size()) {
                return false;
            }
            for (int index = 0; index < beforeSegments.size(); index++) {
                JsonNode before = beforeSegments.get(index);
                JsonNode after = afterSegments.get(index);
                if (!ManagedExtensionRecords.same(before.get("segmentId"),
                        after.get("segmentId"))
                        || !ManagedExtensionRecords.same(before.get("ordinal"),
                                after.get("ordinal"))
                        || !ManagedExtensionRecords.same(before.get("contentRef"),
                                after.get("contentRef"))
                        || (!before.get("receipt").isNull()
                                && !ManagedExtensionRecords.same(
                                        before.get("receipt"),
                                        after.get("receipt")))) {
                    return false;
                }
            }
            if (previous.get("cancelRequested").booleanValue()
                    && !next.get("cancelRequested").booleanValue()) {
                return false;
            }
            if (!ManagedExtensionRecords.isRunSuccessor(previous.get("run"),
                    next.get("run"))) {
                return false;
            }
            // Leaving unknown takes proof: the partial revision must
            // settle a segment the unknown one did not (decision 5).
            if ("unknown".equals(previous.at("/run/delivery/state").textValue())
                    && "partial".equals(next.at("/run/delivery/state").textValue())
                    && settled(next) <= settled(previous)) {
                return false;
            }
            if (ManagedExtensionRecords.TERMINAL.contains(
                    previous.get("run").get("state").textValue())) {
                return ManagedExtensionRecords.same(previous, next);
            }
            return true;
        });
    }

    private static int settled(JsonNode record) {
        int count = 0;
        for (JsonNode segment : record.get("segments")) {
            if (!segment.get("receipt").isNull()) {
                count++;
            }
        }
        return count;
    }

    private static String nullableId(JsonNode node, String label) {
        return node.isNull() ? null : ManagedExtensionRecords.id(node, label);
    }

    private static boolean accepts(BooleanSupplier check) {
        try {
            return check.getAsBoolean();
        } catch (InvalidRecordException exception) {
            return false;
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new InvalidRecordException(message + ".");
        }
    }
}
