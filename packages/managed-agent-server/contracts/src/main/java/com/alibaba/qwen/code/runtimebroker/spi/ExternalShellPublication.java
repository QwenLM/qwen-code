package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;

import java.util.Map;
import java.util.concurrent.CompletionStage;

/**
 * The external foreground-Shell capture lane (#15512 slice C).
 *
 * <p>The external worker keeps its own capture store and exposes it read-only
 * over {@code publication:begin} / {@code publication:read} /
 * {@code publication:stop-drained}; it holds no control-plane credential. The
 * Broker therefore acts as the control plane's producer for that worker: it
 * opens the worker channel, moves the bytes across and acknowledges every
 * sequence, including each stream's empty EOF sequence, before the guarded
 * drained stop may run.
 *
 * <p>A Runtime that cannot prove the lane answers no producer at all, so the
 * dispatch refuses before any Shell runs.
 */
public interface ExternalShellPublication {
    /**
     * Opens the worker's own capture channel for one already-admitted
     * execution and returns its channel id. The grant names the original
     * publication binding; it is never installed on the worker.
     */
    CompletionStage<String> begin(RuntimeLease lease,
            RuntimeBindingRecord binding, ToolExecutionRecord execution,
            RuntimePublicationGrant grant);

    /**
     * Extends the worker channel to the grant's current horizon. The grant is
     * bounded by the writer lease and renewed for as long as the Harness owns
     * the Session, while a foreground Shell may outlive one lease; a channel
     * frozen at its opening horizon would close mid-command and no drain could
     * ever complete.
     */
    CompletionStage<Void> renew(RuntimeLease lease, RuntimeBindingRecord binding,
            RuntimePublicationGrant grant, String channelId);

    /**
     * Moves the worker's captured bytes to the control plane and finishes the
     * original publication, acknowledging every delivered sequence. A stage
     * that fails leaves the channel undrained, so the worker keeps the capture
     * and the close refuses rather than releasing storage.
     */
    CompletionStage<Void> drain(RuntimeLease lease,
            RuntimeBindingRecord binding, ToolExecutionRecord execution,
            RuntimePublicationGrant grant, String channelId,
            Map<String, Object> result);
}
