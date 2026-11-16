package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The Broker's half of the external foreground-Shell capture protocol against a
 * real worker process over HTTP (#15512 slice C).
 *
 * <p>Every other case in this slice stubs the transport or the publication
 * verifier, so none of them shows that the two halves agree on the wire. This
 * one starts the worker stand-in — which implements the shipped worker's
 * channel rules — and drives it through the real attesting transport: the
 * closed request shapes, the pinned identity headers, the base64 blocks and
 * their receipts, the EOF as its own empty sequence, and the acknowledgement
 * that lets the drained stop answer at all.
 *
 * <p>What this still does not cover: the producer's own publication writes into
 * the control-plane store, which needs the full reservation chain. Here the
 * worker side is real and the Broker's copy cursor is driven directly, so a
 * disagreement between the two halves fails these cases.
 */
class ExternalShellWorkerProtocolTest {
    private static final long REVISION = 1;

    private static final Map<String, Object> REFERENCE = Map.of(
            "sessionId", "runtime", "promptId", "turn", "callId", "call",
            "argsDigest", "sha256:" + "b".repeat(64));
    private static final Map<String, Object> CAPTURE = Map.of(
            "tenantId", "tenant", "sessionId", "harness", "turnId", "turn",
            "executionCallId", "execution", "bindingGeneration", "1",
            "capturePolicy", "complete_required");

    private static String begin(ExternalShellWorkerFixture worker, HttpRuntimeTransport transport) {
        return begin(worker, transport, System.currentTimeMillis() + 600_000);
    }

    private static String begin(ExternalShellWorkerFixture worker, HttpRuntimeTransport transport,
            long expiresAt) {
        return transport.externalPublicationBegin(worker.lease, worker.request, worker.seed,
                REVISION, REFERENCE, CAPTURE, expiresAt, "capture-a").toCompletableFuture().join();
    }

    @Test
    @Timeout(60)
    void opensOneChannelPerExecutionAndReadsEveryBlockThroughItsEof() throws Exception {
        try (var worker = ExternalShellWorkerFixture.start("hello\nworld\n", "")) {
            var transport = worker.transport();
            var channel = begin(worker, transport);
            assertTrue(channel.matches("[0-9a-f-]{36}"), "The worker mints the channel id: " + channel);

            // begin is idempotent per execution, which is what lets a recovered
            // dispatch get the channel the original one opened.
            assertEquals(channel, begin(worker, transport),
                    "A recovered dispatch must get the original channel");

            var stdout = worker.copy(transport, channel, "stdout");
            assertEquals("hello\nworld\n", stdout.bytes());
            assertEquals(List.of(false, true), stdout.eofs(),
                    "The EOF is its own empty sequence after the data blocks");
            // An empty stream still has its EOF: without it the stream is never
            // bounded and the drained stop could never answer.
            var stderr = worker.copy(transport, channel, "stderr");
            assertEquals("", stderr.bytes());
            assertEquals(List.of(true), stderr.eofs());

            assertEquals("drained", worker.stopDrained(transport));
        }
    }

    @Test
    @Timeout(60)
    void copiesALargeCaptureBlockByBlockWithoutLosingOrReorderingBytes() throws Exception {
        // Larger than one 32 KiB block, and not a multiple of it, so the last
        // data block is short and the EOF still follows it.
        var payload = "x".repeat(32 * 1024) + "y".repeat(11) + "\n";
        try (var worker = ExternalShellWorkerFixture.start(payload, "")) {
            var transport = worker.transport();
            var channel = begin(worker, transport);
            var stdout = worker.copy(transport, channel, "stdout");

            assertEquals(payload, stdout.bytes());
            assertEquals(List.of(false, false, true), stdout.eofs());
            worker.copy(transport, channel, "stderr");
            assertEquals("drained", worker.stopDrained(transport));
        }
    }

    @Test
    @Timeout(60)
    void renewsTheChannelHorizonForwardSoALongCommandOutlivesOneLease() throws Exception {
        try (var worker = ExternalShellWorkerFixture.start("witness\n", "")) {
            var transport = worker.transport();
            // A horizon only a moment away, as a writer lease about to lapse.
            var channel = begin(worker, transport, System.currentTimeMillis() + 2_000);
            long extended = System.currentTimeMillis() + 600_000;
            transport.externalPublicationRenew(worker.lease, worker.request, worker.seed,
                    REVISION, channel, extended).toCompletableFuture().join();

            // A stale renewal must not shorten the live channel. Its horizon is
            // already past by the time the copy runs, so a channel that took it
            // would be closed mid-command and no drain could ever finish.
            // The shipped worker refuses an expired horizon outright (CLOSED),
            // so the renewal round-trip fails instead of silently keeping the
            // current horizon.
            var staleRenewal = assertThrows(CompletionException.class,
                    () -> transport.externalPublicationRenew(worker.lease, worker.request,
                            worker.seed, REVISION, channel, System.currentTimeMillis() - 1_000)
                            .toCompletableFuture().join());
            assertTrue(staleRenewal.getCause() instanceof RuntimeBrokerException);
            assertEquals("witness\n", worker.copy(transport, channel, "stdout").bytes());
            worker.copy(transport, channel, "stderr");
            assertEquals("drained", worker.stopDrained(transport));

            var renewals = worker.routes("renew");
            assertEquals(2, renewals.size());
            assertTrue(renewals.get(0).get("expiresAt").asLong() == extended);
        }
    }

    @Test
    @Timeout(60)
    void anUnacknowledgedEofLeavesTheStopUndrained() throws Exception {
        try (var worker = ExternalShellWorkerFixture.start("witness\n", "")) {
            var transport = worker.transport();
            var channel = begin(worker, transport);
            // Read both of stdout's sequences but acknowledge only the data
            // block. The EOF was delivered and never acked, so the bytes are
            // still owed and the stop must refuse to claim a drained lane.
            // The lagged-ack shape is what the shipped worker accepts: ack one
            // behind the sequence being read.
            transport.externalPublicationRead(worker.lease, worker.request, worker.seed,
                    REVISION, channel, "stdout", 0, -1).toCompletableFuture().join();
            transport.externalPublicationRead(worker.lease, worker.request, worker.seed,
                    REVISION, channel, "stdout", 1, 0).toCompletableFuture().join();

            assertEquals("undrained", worker.stopDrained(transport));
        }
    }

    @Test
    @Timeout(60)
    void aFutureAcknowledgementIsRefusedBeforeItCanSkipUndeliveredBytes() throws Exception {
        try (var worker = ExternalShellWorkerFixture.start("witness\n", "")) {
            var transport = worker.transport();
            var channel = begin(worker, transport);
            // Acknowledging ahead of the cursor is the one way the Broker could
            // claim bytes it never received; the transport refuses it locally.
            assertThrows(IllegalArgumentException.class, () ->
                    transport.externalPublicationRead(worker.lease, worker.request, worker.seed,
                            REVISION, channel, "stdout", 0, 1));
            assertEquals("undrained", worker.stopDrained(transport));
        }
    }

    @Test
    @Timeout(60)
    void readinessIsTheWorkersOwnClosedLaneRefusalNotATransportFailure() throws Exception {
        try (var worker = ExternalShellWorkerFixture.start("witness\n", "")) {
            var transport = worker.transport();
            // The probe names a channel that cannot exist. The worker's own
            // closed-lane refusal is the positive answer.
            assertTrue(transport.externalPublicationReady(worker.lease, worker.request,
                    worker.seed, REVISION).toCompletableFuture().join());
        }
        // A dead worker is absence of evidence, never evidence that it is gone:
        // readiness must be false rather than an exception the caller reads as
        // a retired generation.
        var dead = ExternalShellWorkerFixture.start("witness\n", "");
        var transport = dead.transport();
        dead.close();
        assertFalse(transport.externalPublicationReady(dead.lease, dead.request,
                dead.seed, REVISION).toCompletableFuture().join());
    }

    @Test
    @Timeout(60)
    void aForeignLeaseOrIncarnationNeverReachesTheCapture() throws Exception {
        try (var worker = ExternalShellWorkerFixture.start("secret output\n", "")) {
            var transport = worker.transport();
            var channel = begin(worker, transport);
            // Each exchange attests first, so a replaced worker generation is
            // refused before any publication request is sent.
            var foreign = new RuntimeLease(worker.lease.getRuntimeInstanceId(),
                    worker.lease.getEndpoint(), "another-token-1234567890",
                    worker.lease.getLeaseId(), worker.lease.getEpoch());
            // The seed binds the lease, so a foreign token is refused locally
            // before any request leaves this process.
            assertThrows(IllegalArgumentException.class, () ->
                    transport.externalPublicationRead(foreign, worker.request, worker.seed,
                            REVISION, channel, "stdout", 0, -1));
            assertTrue(worker.routes("read").isEmpty(),
                    "A foreign lease must not reach the capture at all");

            var staleSeed = new RuntimeProvisionSeed(worker.seed.getProvisionRequestId(),
                    worker.seed.getProvisionalRuntimeId(), "stale-incarnation",
                    worker.seed.getLeaseId(), worker.seed.getEpoch(), worker.seed.getToken());
            // A stale incarnation passes the local binding but the worker's own
            // attestation refuses it, so the capture is still never reached.
            var refused = assertThrows(CompletionException.class, () ->
                    transport.externalPublicationRead(worker.lease, worker.request, staleSeed,
                            REVISION, channel, "stdout", 0, -1).toCompletableFuture().join());
            assertNotNull(refused.getCause());
            assertTrue(worker.routes("read").isEmpty());
        }
    }

    @Test
    @Timeout(60)
    void aStreamWhoseProcessHasNotEndedAnswersPendingInsteadOfAnEmptyBlock() throws Exception {
        try (var worker = ExternalShellWorkerFixture.start("witness\n", "", "--never-ready")) {
            var transport = worker.transport();
            var channel = begin(worker, transport);
            // The worker settles its capture only once the process ends. Until
            // then `pending` is the honest answer, and it must not be read as an
            // empty block — that would truncate the stream at its first byte
            // and publish a short capture as if it were complete.
            var answer = transport.externalPublicationRead(worker.lease, worker.request,
                    worker.seed, REVISION, channel, "stdout", 0, -1).toCompletableFuture().join();
            assertEquals(Map.of("state", "pending"), answer);

            // Nothing was delivered, so the lane still owes every byte.
            assertEquals("undrained", worker.stopDrained(transport));
        }
    }

    @Test
    @Timeout(60)
    void anUnreachableWorkerEndsTheExchangeOnTheTransportsOwnDeadline() throws Exception {
        var worker = ExternalShellWorkerFixture.start("witness\n", "");
        var transport = worker.transport(Duration.ofSeconds(2));
        var channel = begin(worker, transport);
        // A vanished worker mid-copy: the exchange must end on its own timeout
        // rather than pin the drain's carrier for ever.
        worker.close();
        var failure = assertThrows(CompletionException.class, () ->
                transport.externalPublicationRead(worker.lease, worker.request, worker.seed,
                        REVISION, channel, "stdout", 0, -1).toCompletableFuture().join());
        assertNotNull(failure.getCause());
    }
}
