package com.alibaba.qwen.code.managedagent.repository;

import java.util.List;
import java.util.Optional;

public interface ChannelInstanceStore {
    public static final List<String> INSTANCE_STATES = List.of("connected",
            "disconnected");

    public record ChannelInstance(String tenantId, String channelId,
            String platform, String accountId, long accountGeneration,
            String state, String actorId, String workspaceId,
            String cwdRelative, String policyJson, long createdAt,
            long updatedAt) {
    }

    public record InstanceCursor(long createdAt, String channelId) {
    }

    public record InstancePage(List<ChannelInstance> instances,
            boolean hasMore) {
    }

    public record ChannelBinding(String tenantId, String channelId,
            String routeId, String sessionId, String scopeKind,
            String senderId, String chatId, String threadId,
            long createdAt) {
    }

    public record ChannelClaim(String tenantId, String channelId,
            String deliveryId, String sessionId, long claimedAt, long claimGeneration) {
    }

    public record PendingDelivery(String sessionId, String deliveryId,
            long revision, String deliveryState, String recordResourceId) {
    }

    public record DeliveryRecordState(String deliveryState,
            String recordResourceId) {
    }

    public ChannelInstance register(ChannelInstance candidate);

    public Optional<ChannelInstance> setState(String tenantId,
            String channelId, String state);

    public Optional<ChannelInstance> findInstance(String tenantId,
            String channelId);

    public InstancePage listInstances(String tenantId, InstanceCursor before,
            int limit);

    public Optional<ChannelBinding> findBinding(String tenantId,
            String channelId, String routeId);

    public ChannelBinding bind(ChannelBinding candidate);

    public List<String> listSessionsWithPendingDeliveries(String tenantId,
            String channelId, int limit);

    public Optional<DeliveryRecordState> findDeliveryRecord(String tenantId,
            String sessionId, String deliveryId);

    public List<PendingDelivery> findPendingDeliveries(String tenantId,
            String sessionId, int limit);

    public String readResource(String tenantId, String sessionId, String resourceId);

    public ChannelClaim claim(String tenantId, String channelId,
            String deliveryId, String sessionId);

    public ChannelClaim touchClaim(String tenantId, String channelId,
            String deliveryId);

    public Optional<ChannelClaim> findClaim(String tenantId, String channelId,
            String deliveryId);

    public static final String RECONCILE_OPERATION_PREFIX = "channel-reconcile:";

    public boolean reserveReconciliation(ChannelClaim claim);

    public List<ChannelClaim> findExpiredClaims(long before, int limit);

    public String sessionStatus(String tenantId, String sessionId);

    public long databaseNow();

    public static String reconciliationOperationId(ChannelClaim claim) {
        return RECONCILE_OPERATION_PREFIX + com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                claim.tenantId(), claim.channelId(), claim.deliveryId(), Long.toString(claim.claimGeneration()));
    }
}
