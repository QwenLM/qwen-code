package com.alibaba.qwen.code.runtimebroker;

import java.time.Instant;

/** Durable identity and lifecycle for one logical Runtime Session. */
public final class RuntimeSessionRecord {
    public enum State {
        ACQUIRING,
        READY,
        RELEASING,
        RELEASED,
        FAILED
    }

    private final RuntimeSession session;
    private final String bindingId;
    private final long runtimeGeneration;
    private final State state;
    private final long version;
    private final Instant lastActiveAt;

    public RuntimeSessionRecord(RuntimeSession session, String bindingId,
            long runtimeGeneration, State state, long version,
            Instant lastActiveAt) {
        if (session == null) {
            throw new IllegalArgumentException("session is required");
        }
        this.bindingId = BrokerValues.requireId(bindingId, "bindingId");
        if (runtimeGeneration <= 0) {
            throw new IllegalArgumentException(
                    "runtimeGeneration must be positive");
        }
        if (state == null) {
            throw new IllegalArgumentException("state is required");
        }
        if (version < 0) {
            throw new IllegalArgumentException("version must be non-negative");
        }
        if (lastActiveAt == null) {
            throw new IllegalArgumentException("lastActiveAt is required");
        }
        this.session = session;
        this.runtimeGeneration = runtimeGeneration;
        this.state = state;
        this.version = version;
        this.lastActiveAt = lastActiveAt;
    }

    public RuntimeSession getSession() {
        return session;
    }

    public String getRuntimeSessionId() {
        return session.getRuntimeSessionId();
    }

    public String getBindingId() {
        return bindingId;
    }

    public long getRuntimeGeneration() {
        return runtimeGeneration;
    }

    public State getState() {
        return state;
    }

    public long getVersion() {
        return version;
    }

    public Instant getLastActiveAt() {
        return lastActiveAt;
    }

    public boolean isActive() {
        return state != State.RELEASED && state != State.FAILED;
    }

    public boolean isAcquirable() {
        return state == State.ACQUIRING || state == State.READY;
    }

    public RuntimeSessionRecord withState(State nextState,
            Instant activeAt) {
        return new RuntimeSessionRecord(session, bindingId,
                runtimeGeneration, nextState, version, activeAt);
    }

    RuntimeSessionRecord withVersion(long nextVersion) {
        return new RuntimeSessionRecord(session, bindingId,
                runtimeGeneration, state, nextVersion, lastActiveAt);
    }

    boolean sameIdentity(RuntimeSessionRecord other) {
        if (other == null || !bindingId.equals(other.bindingId)
                || runtimeGeneration != other.runtimeGeneration) {
            return false;
        }
        RuntimeSession candidate = other.session;
        return session.getHarnessSessionId().equals(
                candidate.getHarnessSessionId())
                && session.getRuntimeSessionId().equals(
                        candidate.getRuntimeSessionId())
                && session.getTurnKind().equals(candidate.getTurnKind())
                && session.getScope().equals(candidate.getScope());
    }
}
