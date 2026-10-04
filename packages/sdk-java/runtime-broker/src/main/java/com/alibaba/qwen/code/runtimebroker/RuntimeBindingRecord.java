package com.alibaba.qwen.code.runtimebroker;

import java.time.Instant;
import java.util.Objects;

/** Durable state for one physical Managed Runtime generation. */
public final class RuntimeBindingRecord {
    public enum State {
        PROVISIONING,
        READY,
        DRAINING,
        LOST,
        RECOVERY_BLOCKED,
        OPERATOR_RECOVERY,
        FAILED,
        RELEASED
    }

    private final String bindingId;
    private final RuntimeProvisionRequest request;
    private final RuntimeProvisionSeed provisionSeed;
    private final long generation;
    private final State state;
    private final RuntimeLease lease;
    private final RuntimeResourceHandle resourceHandle;
    private final long attestationGeneration;
    private final boolean drainRequested;
    private final String operationOwner;
    private final Instant operationLeaseUntil;
    private final long operationGeneration;
    private final long version;
    private final Instant lastHealthAt;
    private final Instant lastReconciledAt;
    private final Instant lastActiveAt;
    private final RuntimeRecoveryEvidence lossEvidence;
    private final RuntimeRecoveryEvidence stopEvidence;
    private final RuntimeDrainReceipt drainReceipt;

    public RuntimeBindingRecord(String bindingId,
            RuntimeProvisionRequest request, long generation, State state,
            RuntimeLease lease, boolean drainRequested,
            String operationOwner, Instant operationLeaseUntil,
            long operationGeneration, long version, Instant lastHealthAt,
            Instant lastActiveAt) {
        this(bindingId, request, null, generation, state, lease, null, 0,
                drainRequested, operationOwner, operationLeaseUntil,
                operationGeneration, version, lastHealthAt, null,
                lastActiveAt);
    }

    public RuntimeBindingRecord(String bindingId,
            RuntimeProvisionRequest request,
            RuntimeProvisionSeed provisionSeed, long generation, State state,
            RuntimeLease lease, boolean drainRequested,
            String operationOwner, Instant operationLeaseUntil,
            long operationGeneration, long version, Instant lastHealthAt,
            Instant lastActiveAt) {
        this(bindingId, request, provisionSeed, generation, state, lease,
                null, 0, drainRequested, operationOwner,
                operationLeaseUntil, operationGeneration, version,
                lastHealthAt, null, lastActiveAt);
    }

    public RuntimeBindingRecord(String bindingId,
            RuntimeProvisionRequest request,
            RuntimeProvisionSeed provisionSeed, long generation, State state,
            RuntimeLease lease, RuntimeResourceHandle resourceHandle,
            long attestationGeneration, boolean drainRequested,
            String operationOwner, Instant operationLeaseUntil,
            long operationGeneration, long version, Instant lastHealthAt,
            Instant lastReconciledAt, Instant lastActiveAt) {
        this(bindingId, request, provisionSeed, generation, state, lease,
                resourceHandle, attestationGeneration, drainRequested,
                operationOwner, operationLeaseUntil, operationGeneration,
                version, lastHealthAt, lastReconciledAt, lastActiveAt, null, null);
    }

    RuntimeBindingRecord(String bindingId, RuntimeProvisionRequest request,
            RuntimeProvisionSeed provisionSeed, long generation, State state,
            RuntimeLease lease, RuntimeResourceHandle resourceHandle,
            long attestationGeneration, boolean drainRequested,
            String operationOwner, Instant operationLeaseUntil,
            long operationGeneration, long version, Instant lastHealthAt,
            Instant lastReconciledAt, Instant lastActiveAt,
            RuntimeRecoveryEvidence lossEvidence, RuntimeRecoveryEvidence stopEvidence) {
        this(bindingId, request, provisionSeed, generation, state, lease, resourceHandle,
                attestationGeneration, drainRequested, operationOwner, operationLeaseUntil,
                operationGeneration, version, lastHealthAt, lastReconciledAt, lastActiveAt,
                lossEvidence, stopEvidence, null);
    }

    RuntimeBindingRecord(String bindingId, RuntimeProvisionRequest request,
            RuntimeProvisionSeed provisionSeed, long generation, State state,
            RuntimeLease lease, RuntimeResourceHandle resourceHandle,
            long attestationGeneration, boolean drainRequested,
            String operationOwner, Instant operationLeaseUntil,
            long operationGeneration, long version, Instant lastHealthAt,
            Instant lastReconciledAt, Instant lastActiveAt,
            RuntimeRecoveryEvidence lossEvidence, RuntimeRecoveryEvidence stopEvidence,
            RuntimeDrainReceipt drainReceipt) {
        this.bindingId = BrokerValues.requireId(bindingId, "bindingId");
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
        if (generation <= 0) {
            throw new IllegalArgumentException("generation must be positive");
        }
        if (state == null) {
            throw new IllegalArgumentException("state is required");
        }
        if ((operationOwner == null) != (operationLeaseUntil == null)) {
            throw new IllegalArgumentException(
                    "operation owner and lease must be set together");
        }
        if (operationOwner != null) {
            BrokerValues.requireId(operationOwner, "operationOwner");
            if (operationGeneration <= 0) {
                throw new IllegalArgumentException(
                        "claimed operation generation must be positive");
            }
        } else if (operationGeneration < 0) {
            throw new IllegalArgumentException(
                    "operationGeneration must be non-negative");
        }
        if (version < 0) {
            throw new IllegalArgumentException("version must be non-negative");
        }
        if (attestationGeneration < 0) {
            throw new IllegalArgumentException(
                    "attestationGeneration must be non-negative");
        }
        if (lastActiveAt == null) {
            throw new IllegalArgumentException("lastActiveAt is required");
        }
        if (provisionSeed != null && lease != null
                && !provisionSeed.matches(lease)) {
            throw new IllegalArgumentException(
                    "lease must preserve provision credentials");
        }
        if (resourceHandle != null && !request.getProvisionerKind().equals(
                resourceHandle.getKind())) {
            throw new IllegalArgumentException(
                    "resource handle kind must match the provisioner");
        }
        if (request.requiresDurableIdentity() && state == State.READY
                && (provisionSeed == null || lease == null
                        || resourceHandle == null
                        || attestationGeneration <= 0
                        || lastReconciledAt == null)) {
            throw new IllegalArgumentException(
                    "durable ready binding is not attested");
        }
        this.request = request;
        this.provisionSeed = provisionSeed;
        this.generation = generation;
        this.state = state;
        this.lease = lease;
        this.resourceHandle = resourceHandle;
        this.attestationGeneration = attestationGeneration;
        this.drainRequested = drainRequested;
        this.operationOwner = operationOwner;
        this.operationLeaseUntil = operationLeaseUntil;
        this.operationGeneration = operationGeneration;
        this.version = version;
        this.lastHealthAt = lastHealthAt;
        this.lastReconciledAt = lastReconciledAt;
        this.lastActiveAt = lastActiveAt;
        requireEvidence(lossEvidence, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST);
        requireEvidence(stopEvidence, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED);
        if (lossEvidence != null && state != State.LOST && state != State.RELEASED
                && state != State.OPERATOR_RECOVERY) {
            throw new IllegalArgumentException("Loss evidence requires a fenced binding");
        }
        if (stopEvidence != null && (lossEvidence == null
                || !stopEvidence.hostDomain().equals(lossEvidence.hostDomain()))) {
            throw new IllegalArgumentException("Stop evidence must prove the original writer domain");
        }
        this.lossEvidence = lossEvidence;
        this.stopEvidence = stopEvidence;
        if (drainReceipt != null && (!drainRequested || !drainReceipt.matches(this))) {
            throw new IllegalArgumentException("Drain receipt identity differs");
        }
        this.drainReceipt = drainReceipt;
    }

    private void requireEvidence(RuntimeRecoveryEvidence evidence,
            RuntimeRecoveryEvidence.Fact fact) {
        if (evidence != null && (evidence.fact() != fact
                || !evidence.matches(provisionSeed, resourceHandle, lease))) {
            throw new IllegalArgumentException("Recovery evidence identity differs");
        }
    }

    public RuntimeRecoveryEvidence getLossEvidence() {
        return lossEvidence;
    }

    public RuntimeRecoveryEvidence getStopEvidence() {
        return stopEvidence;
    }

    public boolean hasStoppedWriters() {
        return lossEvidence != null && stopEvidence != null;
    }

    public RuntimeBindingRecord withRecoveryEvidence(RuntimeRecoveryEvidence loss,
            RuntimeRecoveryEvidence stop, Instant activeAt) {
        requireEvidence(loss, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST);
        requireEvidence(stop, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED);
        return new RuntimeBindingRecord(bindingId, request, provisionSeed,
                generation, State.LOST, lease, resourceHandle,
                attestationGeneration, drainRequested, operationOwner,
                operationLeaseUntil, operationGeneration, version,
                lastHealthAt, lastReconciledAt, activeAt,
                lossEvidence == null ? loss : lossEvidence,
                stopEvidence == null ? stop : stopEvidence, drainReceipt);
    }

    public RuntimeDrainReceipt getDrainReceipt() {
        return drainReceipt;
    }

    public RuntimeBindingRecord withDrainReceipt(RuntimeDrainReceipt receipt) {
        if (!drainRequested || receipt == null || !receipt.matches(this)) {
            throw new IllegalArgumentException("Drain receipt identity differs");
        }
        return new RuntimeBindingRecord(bindingId, request, provisionSeed, generation, state,
                lease, receipt.resourceHandle(), attestationGeneration, drainRequested,
                operationOwner, operationLeaseUntil, operationGeneration, version, lastHealthAt,
                lastReconciledAt, lastActiveAt, lossEvidence, stopEvidence, receipt);
    }

    public String getBindingId() {
        return bindingId;
    }

    public RuntimeProvisionRequest getRequest() {
        return request;
    }

    RuntimeBindingRecord withLifecycleAuthority(RuntimeLifecycleAuthority authority) {
        RuntimeProvisionRequest scoped = new RuntimeProvisionRequest(request.getScope().withLifecycleAuthority(authority),
                request.getIsolationKey(), request.getProvisionerKind(), request.getStorageId());
        return new RuntimeBindingRecord(bindingId, scoped, provisionSeed, generation, state, lease,
                resourceHandle, attestationGeneration, drainRequested, operationOwner, operationLeaseUntil,
                operationGeneration, version, lastHealthAt, lastReconciledAt, lastActiveAt,
                lossEvidence, stopEvidence, drainReceipt);
    }

    public RuntimeProvisionSeed getProvisionSeed() {
        return provisionSeed;
    }

    public long getGeneration() {
        return generation;
    }

    public State getState() {
        return state;
    }

    public RuntimeLease getLease() {
        return lease;
    }

    public RuntimeResourceHandle getResourceHandle() {
        return resourceHandle;
    }

    public long getAttestationGeneration() {
        return attestationGeneration;
    }

    public boolean isDrainRequested() {
        return drainRequested;
    }

    public String getOperationOwner() {
        return operationOwner;
    }

    public Instant getOperationLeaseUntil() {
        return operationLeaseUntil;
    }

    public long getOperationGeneration() {
        return operationGeneration;
    }

    public long getVersion() {
        return version;
    }

    public Instant getLastHealthAt() {
        return lastHealthAt;
    }

    public Instant getLastReconciledAt() {
        return lastReconciledAt;
    }

    public Instant getLastActiveAt() {
        return lastActiveAt;
    }

    public boolean isActive() {
        return state != State.FAILED && state != State.RELEASED;
    }

    public RuntimeBindingRecord withState(State nextState,
            RuntimeLease nextLease, Instant activeAt) {
        return copy(nextState, nextLease, resourceHandle,
                attestationGeneration, drainRequested, operationOwner,
                operationLeaseUntil, operationGeneration, version,
                lastHealthAt, lastReconciledAt, activeAt);
    }

    public RuntimeBindingRecord withResourceHandle(
            RuntimeResourceHandle nextHandle, Instant activeAt) {
        return copy(state, lease, nextHandle, attestationGeneration,
                drainRequested, operationOwner, operationLeaseUntil,
                operationGeneration, version, lastHealthAt,
                lastReconciledAt, activeAt);
    }

    public RuntimeBindingRecord withAttestation(RuntimeLease nextLease,
            RuntimeResourceHandle nextHandle, Instant reconciledAt,
            Instant activeAt) {
        if (reconciledAt == null) {
            throw new IllegalArgumentException("reconciledAt is required");
        }
        return copy(State.READY, nextLease, nextHandle,
                attestationGeneration + 1, drainRequested, operationOwner,
                operationLeaseUntil, operationGeneration, version,
                reconciledAt, reconciledAt, activeAt);
    }

    public RuntimeBindingRecord withDrainRequested(boolean requested,
            Instant activeAt) {
        return copy(state, lease, resourceHandle, attestationGeneration,
                requested, operationOwner, operationLeaseUntil,
                operationGeneration, version, lastHealthAt,
                lastReconciledAt, activeAt);
    }

    public RuntimeBindingRecord withLastHealthAt(Instant healthAt,
            Instant activeAt) {
        return copy(state, lease, resourceHandle, attestationGeneration,
                drainRequested, operationOwner, operationLeaseUntil,
                operationGeneration, version, healthAt, lastReconciledAt,
                activeAt);
    }

    RuntimeBindingRecord withOperation(String owner, Instant leaseUntil,
            long nextOperationGeneration) {
        return copy(state, lease, resourceHandle, attestationGeneration,
                drainRequested, owner, leaseUntil, nextOperationGeneration,
                version, lastHealthAt, lastReconciledAt, lastActiveAt);
    }

    RuntimeBindingRecord withVersion(long nextVersion) {
        return copy(state, lease, resourceHandle, attestationGeneration,
                drainRequested, operationOwner, operationLeaseUntil,
                operationGeneration, nextVersion, lastHealthAt,
                lastReconciledAt, lastActiveAt);
    }

    boolean blocksPlacement(RuntimeProvisionRequest candidate) {
        // A local worker without a lease or attested generation never
        // admitted a Session; failed startup still blocks its own slot.
        boolean unreclaimed = state == State.LOST
                || state == State.DRAINING
                || state == State.OPERATOR_RECOVERY
                || state == State.RECOVERY_BLOCKED
                        && (!LocalProcessRuntimeProvisioner.KIND.equals(
                                        request.getProvisionerKind())
                                || lease != null
                                || attestationGeneration > 0)
                || state == State.FAILED && provisionSeed != null;
        return unreclaimed
                && request.getScope().getTenantId().equals(candidate.getScope().getTenantId())
                && (!request.isManagedContext()
                        || (state == State.OPERATOR_RECOVERY || state == State.LOST || state == State.DRAINING
                                || state == State.RECOVERY_BLOCKED || state == State.FAILED)
                                && (request.getStorageId().equals(candidate.getStorageId())
                                        || request.getScope().getCanonicalCwd().equals(
                                                candidate.getScope().getCanonicalCwd()))
                        || request.getScope().getWorkspaceId().equals(
                                candidate.getScope().getWorkspaceId()));
    }

    void requireSafeReplacement(RuntimeBindingRecord replacement) {
        if (drainReceipt != null && !drainReceipt.equals(replacement.drainReceipt)) {
            throw new IllegalArgumentException("Drain proof cannot be overwritten");
        }
        if (!Objects.equals(lossEvidence, replacement.lossEvidence)
                        && lossEvidence != null
                || !Objects.equals(stopEvidence, replacement.stopEvidence)
                        && stopEvidence != null) {
            throw new IllegalArgumentException("Recovery evidence cannot be overwritten");
        }
        if ((state == State.LOST && replacement.state != State.LOST
                && !(replacement.state == State.RELEASED && replacement.drainReceipt != null))
                || state == State.OPERATOR_RECOVERY
                        && replacement.state != State.OPERATOR_RECOVERY
                        && replacement.state != State.LOST) {
            throw new IllegalArgumentException("Lost binding requires atomic recovery");
        }
        if (state == State.OPERATOR_RECOVERY && replacement.state == State.LOST
                && !replacement.hasStoppedWriters()) {
            throw new IllegalArgumentException("Operator recovery requires stopped-writer evidence");
        }
        if ((state == State.READY || state == State.RECOVERY_BLOCKED
                || state == State.DRAINING) && replacement.state == State.FAILED) {
            throw new IllegalArgumentException("Unproved runtime loss cannot free a placement");
        }
    }

    boolean sameIdentity(RuntimeBindingRecord other) {
        return other != null && bindingId.equals(other.bindingId)
                && request.equals(other.request)
                && Objects.equals(provisionSeed, other.provisionSeed)
                && generation == other.generation;
    }

    boolean sameOperation(RuntimeBindingRecord other) {
        return other != null
                && Objects.equals(operationOwner, other.operationOwner)
                && Objects.equals(operationLeaseUntil,
                        other.operationLeaseUntil)
                && operationGeneration == other.operationGeneration;
    }

    boolean hasLiveOperationAt(Instant now) {
        return operationOwner != null && operationLeaseUntil.isAfter(now);
    }

    private RuntimeBindingRecord copy(State nextState, RuntimeLease nextLease,
            RuntimeResourceHandle nextHandle, long nextAttestationGeneration,
            boolean requested, String owner, Instant leaseUntil,
            long nextOperationGeneration, long nextVersion,
            Instant healthAt, Instant reconciledAt, Instant activeAt) {
        return new RuntimeBindingRecord(bindingId, request, provisionSeed,
                generation, nextState, nextLease, nextHandle,
                nextAttestationGeneration, requested, owner, leaseUntil,
                nextOperationGeneration, nextVersion, healthAt,
                reconciledAt, activeAt, lossEvidence, stopEvidence, drainReceipt);
    }
}
