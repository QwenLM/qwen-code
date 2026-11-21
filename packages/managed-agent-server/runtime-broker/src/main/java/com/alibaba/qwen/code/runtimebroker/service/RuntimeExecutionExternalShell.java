package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.invalid;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.isPublicationV3;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;

/**
 * The external foreground-Shell capture lane, split out of the execution
 * dispatcher along the producer seam: opening and renewing the worker's own
 * channel, and moving its captured bytes into the original publication before
 * the execution settles. The dispatcher keeps the claim, the invoke and the
 * settle; only this lane's bytes and their proof live here.
 */
final class RuntimeExecutionExternalShell {
    private final RuntimePublicationVerifier publicationVerifier;
    private final ToolExecutionRepository executionRepository;
    // The external channel's horizon renewal is a guarded repository read plus
    // an attested HTTP exchange; it must not run on the tick thread that renews
    // every other claim. Virtual threads need no shutdown of their own.
    private final Thread.Builder.OfVirtual channelRenewals =
            Thread.ofVirtual().name("external-shell-renew-", 0);

    RuntimeExecutionExternalShell(RuntimePublicationVerifier publicationVerifier,
            ToolExecutionRepository executionRepository) {
        this.publicationVerifier = publicationVerifier;
        this.executionRepository = executionRepository;
    }

    private static boolean ownsDispatch(ToolExecutionRecord current,
            ToolExecutionRecord claimed) {
        return claimed.getDispatchGeneration() == current.getDispatchGeneration()
                && claimed.getDispatchOwner().equals(current.getDispatchOwner());
    }

    /**
     * The external foreground-Shell lane, whose worker publishes nothing to the
     * control plane: the Broker moves its bytes itself. Every other v3
     * placement has its worker finish its own publication before it settles, so
     * only the durable envelope may answer there; this lane's worker settles on
     * its local capture, and the move below is what makes that result durable.
     */
    static boolean lane(SessionContext context,
            ToolExecutionRecord execution) {
        return WorkspaceExecutionProfile.isExternalShellRequest(context.binding().getRequest())
                && isPublicationV3(execution.getReference());
    }

    /**
     * Re-opens the external worker's channel for a dispatch this process did
     * not start. {@code begin} is idempotent per execution, so the recovery arm
     * gets the channel the original dispatch opened.
     *
     * <p>Every other placement, and a cancel-requested record — which carries
     * no grant and can only settle as not-started — needs no channel at all.
     */
    CompletionStage<String> channel(SessionContext context,
            ToolExecutionRecord executing, RuntimePublicationGrant grant) {
        // A deferred file Tool on the Shell placement has no channel: it
        // publishes nothing, so `lane` is false and there is nothing to open.
        if (!lane(context, executing) || executing.isCancelRequested()) {
            return CompletableFuture.completedFuture(null);
        }
        var producer = publicationVerifier == null ? null : publicationVerifier.externalShell();
        if (producer == null || grant == null) {
            return CompletableFuture.failedFuture(invalid("runtime_payload_invalid",
                    "External Shell requires its original publication grant"));
        }
        return safeStage(() -> producer.begin(context.lease(), context.binding(), executing, grant));
    }

    /**
     * Moves the external worker's capture into the original publication before
     * the execution settles: the producer lane requires a live, non-draining
     * binding and an unsettled execution, so a later attempt could never
     * publish these bytes. A refusal or a lost answer marks the execution
     * UNKNOWN and leaves the worker channel unacknowledged, which keeps the
     * close refusing instead of releasing storage whose bytes never arrived.
     */
    CompletionStage<Map<String, Object>> move(SessionContext context,
            ToolExecutionRecord executing, RuntimePublicationGrant grant,
            String externalChannelId, Map<String, Object> result) {
        // Only the publication-v3 Shell result has bytes to move; a deferred
        // file Tool settles on the worker's own answer.
        if (!lane(context, executing)) {
            return CompletableFuture.completedFuture(result);
        }
        var producer = publicationVerifier == null ? null : publicationVerifier.externalShell();
        boolean started = !"not_started".equals(result.get("executionStatus"));
        boolean captured = started
                && result.get("capture") instanceof Map<?, ?> capture
                && "complete".equals(capture.get("captureStatus"));
        if (!started) {
            // The process never ran, so no channel holds bytes. This is the one
            // started-less outcome the Harness can record as not-started.
            return CompletableFuture.completedFuture(result);
        }
        if (!captured) {
            // A started call with an incomplete capture cannot be published:
            // `finish` admits only a complete capture, so no retry ever moves
            // these bytes. Settling it would be worse than a refusal — the
            // worker's own drain proof would still report `capture_incomplete`
            // forever, while the settled row would let the close reach the stop
            // and then wedge with no exit. Keep the record recoverable instead.
            return CompletableFuture.failedFuture(conflict("workspace_close_identity_unverified",
                    "External Shell capture did not complete"));
        }
        Map<String, Object> alreadyPublished = publicationVerifier == null
                ? null : publicationVerifier.finished(executing);
        if (alreadyPublished != null) {
            // A recovered dispatch whose drain already finished but whose settle
            // did not land. Re-running the move would publish over a FINISHED
            // lane and refuse; the durable envelope is already the outcome.
            return CompletableFuture.completedFuture(alreadyPublished);
        }
        if (producer == null || grant == null || externalChannelId == null) {
            // A complete capture with no lane to move it must not settle: its
            // bytes would be unreachable and the close could never be proven.
            return CompletableFuture.failedFuture(conflict("workspace_close_identity_unverified",
                    "External Shell capture has no original publication channel"));
        }
        ToolExecutionRecord current = executionRepository.findByExecutionCallId(
                executing.getExecutionCallId());
        if (current == null || !ownsDispatch(current, executing)) {
            return CompletableFuture.completedFuture(null);
        }
        return safeStage(() -> producer.drain(context.lease(), context.binding(), current,
                grant, externalChannelId, result))
                .thenApply(ignored -> {
                    // The drain rebuilt the manifest over the bytes it moved and
                    // finished the publication with it, so that envelope — not
                    // the worker's, which names its own local manifest — is the
                    // result this execution owns. The Harness compares the
                    // settled result against `/finished` verbatim, and a later
                    // reconcile answers from the same durable envelope.
                    Map<String, Object> published = publicationVerifier.finished(current);
                    if (published == null) {
                        throw conflict("workspace_close_identity_unverified",
                                "External Shell drain did not finish its publication");
                    }
                    return published;
                });
    }

    /**
     * The worker channel is bounded by the publication grant, whose horizon
     * is the writer lease the Harness keeps renewing. A foreground Shell may
     * outlive one lease, so each dispatch renewal pushes the grant's current
     * horizon there too; without it the capture would close mid-command and
     * the drain could never finish. A refusal is not claim loss: the drain
     * itself re-reads the channel and refuses honestly if it really closed.
     */
    void renewChannel(SessionContext context, ToolExecutionRecord original,
            RuntimePublicationGrant grant, CompletionStage<String> externalChannel,
            AtomicBoolean closed) {
        if (closed.get() || grant == null || publicationVerifier == null
                || !WorkspaceExecutionProfile.isExternalShellRequest(
                        context.binding().getRequest())) {
            return;
        }
        var producer = publicationVerifier.externalShell();
        if (producer == null) {
            return;
        }
        var pending = externalChannel.toCompletableFuture();
        String channelId = pending.isCompletedExceptionally() ? null : pending.getNow(null);
        if (channelId == null) {
            return;
        }
        // The grant recheck takes the publication row's FOR UPDATE and the
        // renewal itself is an attested HTTP exchange. The tick thread also
        // renews every other claim, so neither may run on it: hand the pair
        // to a virtual thread and let the next tick start on time.
        channelRenewals.start(() -> {
            try {
                var current = publicationVerifier.verify(original,
                        grant.publicationId(), grant.token());
                producer.renew(context.lease(), context.binding(), current, channelId)
                        .toCompletableFuture().join();
            } catch (RuntimeException unavailable) {
                // The grant is fenced or the channel is gone. The drain
                // observes the same refusal, so this must not settle or
                // abandon anything here.
            }
        });
    }
}
