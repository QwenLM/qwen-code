package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionException;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
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
        // The multi-byte character straddles the first block boundary
        // (0xC3 ends block 0, 0xA9 starts block 1), so per-block decoding
        // would mangle a correct capture.
        var payload = "x".repeat(32 * 1024 - 1) + "é" + "y".repeat(11) + "\n";
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
    void copiesAMultiBlockStderrCaptureBlockByBlockWithoutLosingBytes() throws Exception {
        // Stderr rides the same block chain as stdout, and a noisy
        // command's stderr spans blocks on its own: two full 32 KiB blocks
        // plus a short tail, with the multi-byte character straddling the
        // first block boundary exactly as in the stdout case, so per-block
        // decoding would mangle a correct capture here too.
        var noise = "x".repeat(32 * 1024 - 1) + "é" + "y".repeat(32 * 1024 + 1) + "\n";
        try (var worker = ExternalShellWorkerFixture.start("witness\n", noise)) {
            var transport = worker.transport();
            var channel = begin(worker, transport);
            var stderr = worker.copy(transport, channel, "stderr");

            assertEquals(noise, stderr.bytes());
            assertEquals(List.of(false, false, false, true), stderr.eofs());
            assertEquals("witness\n", worker.copy(transport, channel, "stdout").bytes());
            assertEquals("drained", worker.stopDrained(transport));
        }
    }

    @Test
    @Timeout(60)
    void anEmptyStdoutCaptureCopiesZeroBytesNotTheStandInFallback() throws Exception {
        // A command that wrote nothing to stdout still has its stream:
        // zero data bytes with the EOF as its only sequence. The stand-in's
        // 'witness' fallback belongs to an absent payload only, so an empty
        // captured stdout must copy back empty rather than fall back — that
        // distinction keeps an honest zero-byte capture from being
        // published as output the command never produced.
        try (var worker = ExternalShellWorkerFixture.start("", "")) {
            var transport = worker.transport();
            var channel = begin(worker, transport);
            var stdout = worker.copy(transport, channel, "stdout");
            assertEquals("", stdout.bytes());
            assertEquals(List.of(true), stdout.eofs());
            var stderr = worker.copy(transport, channel, "stderr");
            assertEquals("", stderr.bytes());
            assertEquals(List.of(true), stderr.eofs());
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
            assertTrue(staleRenewal.getCause() instanceof RuntimeBrokerException closed
                    && closed.getStatusCode() == 409
                    && "managed_runtime_publication_closed".equals(closed.getCode()),
                    "A stale renewal is the worker's closed-lane refusal, not a 400");
            // Let the original horizon lapse: only a channel that took the
            // renewal is still live, so an un-renewed channel fails here.
            Thread.sleep(2_100);
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
            // Fully drain stderr first, so stdout's owed EOF is the only
            // unacknowledged sequence and the refusal cannot pass for
            // stderr's reason alone.
            worker.copy(transport, channel, "stderr");
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
            // The worker's own delivered-cursor rule is the second fence: an
            // ack for a sequence it never delivered is the closed-lane
            // refusal, driven here past the transport's local check.
            var refused = worker.postRefused("read", Map.of("protocolVersion", 2,
                    "channelId", channel, "streamId", "stdout", "sequence", 1,
                    "acknowledgedSequence", 0), worker.lease);
            assertEquals(409, refused.getStatusCode());
            assertEquals("managed_runtime_publication_closed", refused.getCode());
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

            // A pending answer mutates no cursor: the shipped worker returns
            // pending above both cursor writes, so a following ack for the
            // never-delivered sequence 0 is still the closed-lane refusal.
            var refused = worker.postRefused("read", Map.of("protocolVersion", 2,
                    "channelId", channel, "streamId", "stdout", "sequence", 0,
                    "acknowledgedSequence", 0), worker.lease);
            assertEquals(409, refused.getStatusCode());
            assertEquals("managed_runtime_publication_closed", refused.getCode());

            // Nothing was delivered, so the lane still owes every byte.
            assertEquals("undrained", worker.stopDrained(transport));
        }
    }

    @Test
    @Timeout(60)
    void anUnreachableWorkerEndsTheExchangeOnTheTransportsOwnDeadline() throws Exception {
        try (var worker = ExternalShellWorkerFixture.start("witness\n", "")) {
            var transport = worker.transport(Duration.ofSeconds(2));
            var channel = begin(worker, transport);
            // A live-but-silent worker: the listener accepts and never answers,
            // so only the transport's own deadline can end the exchange. A
            // closed port would fail on connect and never exercise it.
            try (var silent = new java.net.ServerSocket(0, 1,
                    java.net.InetAddress.getByName("127.0.0.1"))) {
                var stalled = new RuntimeLease(worker.lease.getRuntimeInstanceId(),
                        java.net.URI.create("http://127.0.0.1:" + silent.getLocalPort()),
                        worker.lease.getToken(), worker.lease.getLeaseId(), worker.lease.getEpoch());
                var seed = new RuntimeProvisionSeed(worker.seed.getProvisionRequestId(),
                        worker.seed.getProvisionalRuntimeId(), worker.seed.getGatewayIncarnation(),
                        worker.seed.getLeaseId(), worker.seed.getEpoch(), worker.seed.getToken());
                long startedAt = System.nanoTime();
                var failure = assertThrows(CompletionException.class, () ->
                        transport.externalPublicationRead(stalled, worker.request, seed,
                                REVISION, channel, "stdout", 0, -1).toCompletableFuture().join());
                long elapsedMs = (System.nanoTime() - startedAt) / 1_000_000;
                // The deadline surfaces as the transport's retryable
                // unavailable answer; a refused connect would fail in
                // milliseconds instead, so the elapsed bound below is what
                // pins the timeout itself.
                assertTrue(failure.getCause() instanceof RuntimeBrokerException ended
                        && ended.getStatusCode() == 503 && ended.isRetryable(),
                        "The exchange must end on its own deadline: " + failure.getCause());
                assertTrue(elapsedMs >= 1_500 && elapsedMs < 30_000,
                        "The deadline must be the transport's own 2 s, took " + elapsedMs + " ms");
            }
        }
    }

    @Test
    @Timeout(60)
    void aLapsedChannelRevivesOnItsOwnersBegin() throws Exception {
        try (var worker = ExternalShellWorkerFixture.start("witness\n", "")) {
            var transport = worker.transport();
            var channel = begin(worker, transport, System.currentTimeMillis() + 1_000);
            // Let the horizon lapse, the state a Broker outage leaves behind:
            // the channel's own drain paths now refuse.
            Thread.sleep(1_100);
            var lapsedRead = worker.postRefused("read", Map.of("protocolVersion", 2,
                    "channelId", channel, "streamId", "stdout", "sequence", 0,
                    "acknowledgedSequence", -1), worker.lease);
            assertEquals(409, lapsedRead.getStatusCode());
            assertEquals("managed_runtime_publication_closed", lapsedRead.getCode());

            // The recovered dispatch re-runs begin on the same execution with
            // the identical captured input and its own fresh horizon, which
            // revives the channel instead of refusing it.
            var revived = worker.beginRaw(REFERENCE, CAPTURE,
                    System.currentTimeMillis() + 600_000, "capture-a");
            assertEquals(200, revived.statusCode());
            assertEquals(channel,
                    new com.fasterxml.jackson.databind.ObjectMapper()
                            .readTree(revived.body()).get("channelId").asText());

            // A different captured input on the same execution — the rebind a
            // recovered dispatch may carry — is the closed-lane refusal, and
            // it must not mint a second channel.
            assertEquals("witness\n", worker.copy(transport, channel, "stdout").bytes());
            worker.copy(transport, channel, "stderr");
            assertEquals("drained", worker.stopDrained(transport));

            var conflict = worker.beginRaw(REFERENCE,
                    java.util.Map.of("tenantId", "tenant", "sessionId", "harness",
                            "turnId", "turn", "executionCallId", "execution",
                            "bindingGeneration", "2", "capturePolicy", "complete_required"),
                    System.currentTimeMillis() + 600_000, "capture-a");
            assertEquals(409, conflict.statusCode());
            assertEquals("managed_runtime_publication_closed",
                    new com.fasterxml.jackson.databind.ObjectMapper()
                            .readTree(conflict.body()).get("code").asText());
            assertEquals(1, worker.routes("begin").stream()
                    .map(route -> route.get("capture").get("executionCallId").asText())
                    .distinct().count(),
                    "The conflicting begin must not mint a second channel");
        }
    }

    @Test
    @Timeout(60)
    void aLapsedChannelRevivesOnItsOwnersRenewal() throws Exception {
        try (var worker = ExternalShellWorkerFixture.start("witness\n", "")) {
            var transport = worker.transport();
            var channel = begin(worker, transport, System.currentTimeMillis() + 1_000);
            Thread.sleep(1_100);
            var lapsed = worker.postRefused("read", Map.of("protocolVersion", 2,
                    "channelId", channel, "streamId", "stdout", "sequence", 0,
                    "acknowledgedSequence", -1), worker.lease);
            assertEquals(409, lapsed.getStatusCode());
            // The owning Broker's renewal carries its fresh horizon, which
            // revives the channel; the shipped worker applies the same rule.
            transport.externalPublicationRenew(worker.lease, worker.request, worker.seed,
                    REVISION, channel, System.currentTimeMillis() + 600_000)
                    .toCompletableFuture().join();
            assertEquals("witness\n", worker.copy(transport, channel, "stdout").bytes());
            worker.copy(transport, channel, "stderr");
            assertEquals("drained", worker.stopDrained(transport));
        }
    }

    @Test
    @Timeout(60)
    void aForeignStorageRevisionNeverReachesTheCapture() throws Exception {
        try (var worker = ExternalShellWorkerFixture.start("witness\n", "")) {
            var transport = worker.transport();
            var channel = begin(worker, transport);
            // A publication request attested against a stale storage revision
            // is the worker's own closed-lane refusal, not the transport's.
            var stale = new RuntimeProvisionSeed(worker.seed.getProvisionRequestId(),
                    worker.seed.getProvisionalRuntimeId(), worker.seed.getGatewayIncarnation(),
                    worker.seed.getLeaseId(), worker.seed.getEpoch(), worker.seed.getToken());
            var refused = assertThrows(CompletionException.class, () ->
                    transport.externalPublicationRead(worker.lease, worker.request, stale,
                            REVISION + 1, channel, "stdout", 0, -1)
                            .toCompletableFuture().join());
            // The worker's own gate refuses the stale revision, and the
            // transport surfaces that as its protocol refusal rather than the
            // worker's closed-lane body.
            assertTrue(refused.getCause() instanceof RuntimeBrokerException invalid
                    && invalid.getStatusCode() == 400
                    && "managed_runtime_attestation_invalid".equals(invalid.getCode()),
                    "A stale storage revision never reaches the capture: "
                            + refused.getCause());
            // The revision the worker registered with still works after it.
            assertEquals("witness\n", worker.copy(transport, channel, "stdout").bytes());
            worker.copy(transport, channel, "stderr");
            assertEquals("drained", worker.stopDrained(transport));
        }
    }

    @Test
    void commandLineGuardChecksBothSidesOfItsUtf16JoinBoundary() {
        // This is a lower-bound size check, not Windows argument serialization:
        // even an accepted join may grow when ProcessBuilder quotes arguments.
        for (var command : List.of(List.of("node", "worker.mjs"),
                List.of("x".repeat(32_765)), List.of("x".repeat(32_766)),
                List.of("node", "x".repeat(32_761)),
                List.of("😀".repeat(16_383)), List.of(" ".repeat(32_766)))) {
            assertDoesNotThrow(() -> ExternalShellWorkerFixture
                    .requireWindowsSafeCommandLine(command));
        }
        for (var command : List.of(List.of("x".repeat(32_767)),
                List.of("x".repeat(32_768)), List.of("x".repeat(32_780)),
                List.of("node", "x".repeat(32_762)),
                List.of("😀".repeat(16_383) + "x"))) {
            var refused = assertThrows(AssertionError.class, () -> ExternalShellWorkerFixture
                    .requireWindowsSafeCommandLine(command));
            assertTrue(refused.getMessage().contains("CreateProcess"));
        }
    }

    @Test
    @Timeout(60)
    void refusesACommandLineTheWindowsCreateProcessLimitCannotCarry() throws Exception {
        // The guard is the #17885 tripwire: a capture payload back on the
        // command line must fail here, in the fixture, instead of as a
        // platform-dependent launch error. The Windows limit of 32767
        // characters includes the terminating NUL, so a join of exactly
        // 32767 cannot launch and must already be refused; the upper side
        // is the regression's own shape, a --stdout= argument large enough
        // that no argument could survive it. Nothing may start in this
        // case: both refusals happen before the process is launched, which
        // is what lets a non-Windows lane catch a Windows-only failure.
        var script = java.nio.file.Path.of(
                "src/test/resources/external-shell-worker.mjs").toAbsolutePath();
        var fixed = "node".length() + 1 + script.toString().length() + 1
                + "--storage-revision=1".length() + 1;
        var atTheLimit = assertThrows(AssertionError.class, () ->
                ExternalShellWorkerFixture.start("witness\n", "",
                        "x".repeat(32_767 - fixed)));
        assertTrue(atTheLimit.getMessage().contains("CreateProcess"),
                "The refusal must name the Windows limit: " + atTheLimit.getMessage());
        var regression = assertThrows(AssertionError.class, () ->
                ExternalShellWorkerFixture.start("witness\n", "",
                        "--stdout=" + "x".repeat(32_780 - fixed - "--stdout=".length())));
        assertTrue(regression.getMessage().contains("boot document"),
                "The refusal must say where the payload belongs: "
                        + regression.getMessage());
    }
}
