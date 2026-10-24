package com.alibaba.qwen.code.runtimebroker;

import java.net.URI;

/** One scheduler reconciliation result for a physical Runtime. */
public final class RuntimeObservation {
    public enum Outcome {
        READY,
        STARTING,
        NOT_FOUND,
        CONFLICT,
        UNKNOWN
    }

    private final Outcome outcome;
    private final RuntimeResourceHandle handle;
    private final URI endpoint;
    private final String runtimeInstanceId;
    private final String leaseId;
    private final long epoch;
    private final RuntimeRecoveryEvidence lossEvidence;
    private final RuntimeRecoveryEvidence stopEvidence;

    private RuntimeObservation(Outcome outcome,
            RuntimeResourceHandle handle, URI endpoint,
            String runtimeInstanceId, String leaseId, long epoch) {
        this(outcome, handle, endpoint, runtimeInstanceId, leaseId, epoch, null, null);
    }

    private RuntimeObservation(Outcome outcome, RuntimeResourceHandle handle,
            URI endpoint, String runtimeInstanceId, String leaseId, long epoch,
            RuntimeRecoveryEvidence lossEvidence, RuntimeRecoveryEvidence stopEvidence) {
        this.lossEvidence = lossEvidence;
        this.stopEvidence = stopEvidence;
        if (outcome == null) {
            throw new IllegalArgumentException("outcome is required");
        }
        if (outcome == Outcome.READY) {
            if (handle == null || endpoint == null
                    || runtimeInstanceId == null || leaseId == null
                    || epoch <= 0) {
                throw new IllegalArgumentException(
                        "ready observation is incomplete");
            }
            this.endpoint = BrokerValues.requireOrigin(endpoint, "endpoint");
            this.runtimeInstanceId = BrokerValues.requireId(
                    runtimeInstanceId, "runtimeInstanceId");
            this.leaseId = BrokerValues.requireId(leaseId, "leaseId");
        } else {
            if (endpoint != null || runtimeInstanceId != null
                    || leaseId != null || epoch != 0) {
                throw new IllegalArgumentException(
                        "non-ready observation contains a lease");
            }
            this.endpoint = null;
            this.runtimeInstanceId = null;
            this.leaseId = null;
        }
        this.outcome = outcome;
        this.handle = handle;
        this.epoch = epoch;
    }

    public static RuntimeObservation ready(RuntimeResourceHandle handle,
            URI endpoint, String runtimeInstanceId, String leaseId,
            long epoch) {
        return new RuntimeObservation(Outcome.READY, handle, endpoint,
                runtimeInstanceId, leaseId, epoch);
    }

    public static RuntimeObservation starting(RuntimeResourceHandle handle) {
        return new RuntimeObservation(Outcome.STARTING, handle, null, null,
                null, 0);
    }

    public static RuntimeObservation notFound() {
        return new RuntimeObservation(Outcome.NOT_FOUND, null, null, null,
                null, 0);
    }

    public static RuntimeObservation notFound(RuntimeRecoveryEvidence loss,
            RuntimeRecoveryEvidence stop) {
        if (loss == null || loss.fact() != RuntimeRecoveryEvidence.Fact.JOURNAL_LOST
                || stop != null && stop.fact() != RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED) {
            throw new IllegalArgumentException("Loss evidence is required");
        }
        return new RuntimeObservation(Outcome.NOT_FOUND, loss.resourceHandle(),
                null, null, null, 0, loss, stop);
    }

    public RuntimeRecoveryEvidence getLossEvidence() {
        return lossEvidence;
    }

    public RuntimeRecoveryEvidence getStopEvidence() {
        return stopEvidence;
    }

    public static RuntimeObservation conflict(RuntimeResourceHandle handle) {
        return new RuntimeObservation(Outcome.CONFLICT, handle, null, null,
                null, 0);
    }

    public static RuntimeObservation unknown(RuntimeResourceHandle handle) {
        return new RuntimeObservation(Outcome.UNKNOWN, handle, null, null,
                null, 0);
    }

    public Outcome getOutcome() {
        return outcome;
    }

    public RuntimeResourceHandle getHandle() {
        return handle;
    }

    public URI getEndpoint() {
        return endpoint;
    }

    public String getRuntimeInstanceId() {
        return runtimeInstanceId;
    }

    public String getLeaseId() {
        return leaseId;
    }

    public long getEpoch() {
        return epoch;
    }
}
