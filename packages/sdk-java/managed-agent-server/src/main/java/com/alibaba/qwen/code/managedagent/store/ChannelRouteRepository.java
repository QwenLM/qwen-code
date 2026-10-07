package com.alibaba.qwen.code.managedagent.store;

import java.util.List;
import java.util.Optional;

/**
 * Persistence boundary for the H5 channel ingress route bindings
 * (qwen_managed_channel_route). One row per binding identity: channel
 * instance, account generation, platform event and semantic revision. Two
 * distinct platform events stay two rows even when their text is identical.
 */
public interface ChannelRouteRepository {
    /** The states a route binding can be in. */
    List<String> ROUTE_STATES = List.of("staged", "admitted");

    /** Separator of the route key components; identities must not hold it. */
    String SEPARATOR = Character.toString((char) 0);

    /** One committed route binding. */
    record ChannelRoute(
            String tenantId,
            String routeKey,
            String channelInstanceId,
            long accountGeneration,
            String platformEventId,
            long semanticRevision,
            String sessionId,
            String senderId,
            String chatId,
            String threadId,
            String state,
            String inputId,
            List<String> stagedAttachmentRefs,
            long createdAt,
            long updatedAt) {
    }

    /** Exclusive page cursor: created time and route key of the last row. */
    record RouteCursor(long createdAt, String routeKey) {
    }

    /** One newest-first page of route bindings. */
    record RoutePage(List<ChannelRoute> routes, boolean hasMore) {
    }

    /** The primary key beside the tenant: the binding identity digest. */
    static String routeKey(String tenantId, String channelInstanceId,
            long accountGeneration, String platformEventId,
            long semanticRevision) {
        if (tenantId.contains(SEPARATOR) || channelInstanceId.contains(
                SEPARATOR) || platformEventId.contains(SEPARATOR)) {
            throw new IllegalArgumentException(
                    "route identity must not contain the separator");
        }
        return ChannelStoreSupport.sha256(tenantId + SEPARATOR
                + channelInstanceId + SEPARATOR + accountGeneration
                + SEPARATOR + platformEventId + SEPARATOR + semanticRevision);
    }

    /**
     * Inserts the candidate, or returns the row its binding identity already
     * committed. A candidate whose identity matches an existing row adds
     * nothing, so ingress redelivery of one platform event is one binding.
     */
    ChannelRoute findOrCreate(ChannelRoute candidate);

    Optional<ChannelRoute> find(String tenantId, String routeKey);

    /**
     * Records the input a staged route's Session admitted. Returns null when
     * the binding is absent or already admitted with another input; a replay
     * with the same input returns the current row.
     */
    ChannelRoute admit(String tenantId, String routeKey, String inputId);

    /**
     * Newest first by (createdAt, routeKey) descending; {@code before}
     * excludes its own row. {@code limit} must be in [1, 100].
     */
    RoutePage listByChannel(String tenantId, String channelInstanceId,
            RouteCursor before, int limit);
}
