package com.alibaba.qwen.code.managedagent.contracts.workspace;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;

import java.time.Instant;

import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.digest;

public final class ResidentReclamation {
    private ResidentReclamation() { }
    public static final String DATA_POLICY = "retain-same-tenant-admin-handoff/1";

    public record Baseline(String finalizer, String bootId, String nodeResourceVersion, String nodeHeartbeat,
            String leaseUid, String leaseResourceVersion, String leaseRenewTime, String attachmentUid) { }

    public record Receipt(String resourceIdentity, String baselineDigest, String podResourceVersion,
            String deletionTimestamp, String finishedAt, String nodeResourceVersion, String nodeHeartbeat,
            String leaseResourceVersion, String leaseRenewTime, String observedAt, String dataPolicy) { }

    public static void verifyReceipt(RuntimeBindingRecord original, Baseline baseline, Receipt receipt) {
        require(receipt != null && receipt.resourceIdentity().equals(original.getResourceHandle().getValue().get("identity"))
                && receipt.baselineDigest().equals(digest(baseline)) && DATA_POLICY.equals(receipt.dataPolicy())
                && receipt.observedAt() != null && receipt.finishedAt() != null && receipt.deletionTimestamp() != null
                && !Instant.parse(receipt.observedAt()).isBefore(Instant.parse(receipt.finishedAt())));
        Instant.parse(receipt.deletionTimestamp());
    }
    private static void require(boolean valid) {
        if (!valid) {
            throw unavailable();
        }
    }
    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "resident_reclamation_incomplete", "Original platform cleanup is incomplete.", false);
    }
}
