package com.alibaba.qwen.code.runtimebroker;

import java.time.Instant;
import java.util.Objects;

/** Durable state for one physical Managed Runtime generation. */
public final class RuntimeBindingRecord {
    public enum State {
        PROVISIONING,
        READY,
        DRAINING,
        FAILED,
        RELEASED
    }

    private final String bindingId;
    private final RuntimeProvisionRequest request;
    private final RuntimeProvisionSeed provisionSeed;
    private final long generation;
    private final State state;
    private final RuntimeLease lease;
    private final boolean drainRequested;
    private final String operationOwner;
    private final Instant operationLeaseUntil;
    private final long operationGeneration;
    private final long version;
    private final Instant lastHealthAt;
    private final Instant lastActiveAt;

    public RuntimeBindingRecord(String bindingId,
            RuntimeProvisionRequest request, long generation, State state,
            RuntimeLease lease, boolean drainRequested,
            String operationOwner, Instant operationLeaseUntil,
            long operationGeneration, long version, Instant lastHealthAt,
            Instant lastActiveAt) {
        this(bindingId, request, null, generation, state, lease,
                drainRequested, operationOwner, operationLeaseUntil,
                operationGeneration, version, lastHealthAt, lastActiveAt);
    }

    public RuntimeBindingRecord(String bindingId,
            RuntimeProvisionRequest request,
            RuntimeProvisionSeed provisionSeed, long generation, State state,
            RuntimeLease lease, boolean drainRequested,
            String operationOwner, Instant operationLeaseUntil,
            long operationGeneration, long version, Instant lastHealthAt,
            Instant lastActiveAt) {
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
        if (lastActiveAt == null) {
            throw new IllegalArgumentException("lastActiveAt is required");
        }
        if (provisionSeed != null && lease != null
                && !provisionSeed.matches(lease)) {
            throw new IllegalArgumentException(
                    "lease must preserve provision credentials");
        }
        this.request = request;
        this.provisionSeed = provisionSeed;
        this.generation = generation;
        this.state = state;
        this.lease = lease;
        this.drainRequested = drainRequested;
        this.operationOwner = operationOwner;
        this.operationLeaseUntil = operationLeaseUntil;
        this.operationGeneration = operationGeneration;
        this.version = version;
        this.lastHealthAt = lastHealthAt;
        this.lastActiveAt = lastActiveAt;
    }

    public String getBindingId() {
        return bindingId;
    }

    public RuntimeProvisionRequest getRequest() {
        return request;
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

    public Instant getLastActiveAt() {
        return lastActiveAt;
    }

    public boolean isActive() {
        return state != State.FAILED && state != State.RELEASED;
    }

    public RuntimeBindingRecord withState(State nextState,
            RuntimeLease nextLease, Instant activeAt) {
        return copy(nextState, nextLease, drainRequested, operationOwner,
                operationLeaseUntil, operationGeneration, version,
                lastHealthAt, activeAt);
    }

    public RuntimeBindingRecord withDrainRequested(boolean requested,
            Instant activeAt) {
        return copy(state, lease, requested, operationOwner,
                operationLeaseUntil, operationGeneration, version,
                lastHealthAt, activeAt);
    }

    public RuntimeBindingRecord withLastHealthAt(Instant healthAt,
            Instant activeAt) {
        return copy(state, lease, drainRequested, operationOwner,
                operationLeaseUntil, operationGeneration, version, healthAt,
                activeAt);
    }

    RuntimeBindingRecord withOperation(String owner, Instant leaseUntil,
            long nextOperationGeneration) {
        return copy(state, lease, drainRequested, owner, leaseUntil,
                nextOperationGeneration, version, lastHealthAt,
                lastActiveAt);
    }

    RuntimeBindingRecord withVersion(long nextVersion) {
        return copy(state, lease, drainRequested, operationOwner,
                operationLeaseUntil, operationGeneration, nextVersion,
                lastHealthAt, lastActiveAt);
    }

    boolean sameIdentity(RuntimeBindingRecord other) {
        return other != null && bindingId.equals(other.bindingId)
                && request.equals(other.request)
                && Objects.equals(provisionSeed, other.provisionSeed)
                && generation == other.generation;
    }

    private RuntimeBindingRecord copy(State nextState, RuntimeLease nextLease,
            boolean requested, String owner, Instant leaseUntil,
            long nextOperationGeneration, long nextVersion,
            Instant healthAt, Instant activeAt) {
        return new RuntimeBindingRecord(bindingId, request, provisionSeed,
                generation, nextState, nextLease, requested, owner,
                leaseUntil, nextOperationGeneration, nextVersion, healthAt,
                activeAt);
    }
}
