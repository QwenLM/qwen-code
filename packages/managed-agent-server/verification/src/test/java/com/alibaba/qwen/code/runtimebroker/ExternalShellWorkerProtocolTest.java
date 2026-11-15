package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.provisioning.external.ExternalWorkspaceProvisioner;
import com.alibaba.qwen.code.runtimebroker.provisioning.local.LocalProcessRuntimeProvisionerTest;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

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
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long REVISION = 1;

    @Test
    @Timeout(60)
    void opensOneChannelPerExecutionAndReadsEveryBlockThroughItsEof() throws Exception {
        try (var worker = Worker.start("hello\nworld\n", "")) {
            var transport = worker.transport();
            var channel = worker.begin(transport);
            assertTrue(channel.matches("[0-9a-f-]{36}"), "The worker mints the channel id: " + channel);

            // begin is idempotent per execution, which is what lets a recovered
            // dispatch get the channel the original one opened.
            assertEquals(channel, worker.begin(transport),
                    "A recovered dispatch must get the original channel");

            var stdout = worker.copy(transport, channel, "stdout");
            assertEquals("hello\nworld\n", stdout.bytes);
            assertEquals(List.of(false, true), stdout.eofs,
                    "The EOF is its own empty sequence after the data blocks");
            // An empty stream still has its EOF: without it the stream is never
            // bounded and the drained stop could never answer.
            var stderr = worker.copy(transport, channel, "stderr");
            assertEquals("", stderr.bytes);
            assertEquals(List.of(true), stderr.eofs);

            assertEquals("drained", worker.stopDrained(transport));
        }
    }

    @Test
    @Timeout(60)
    void copiesALargeCaptureBlockByBlockWithoutLosingOrReorderingBytes() throws Exception {
        // Larger than one 32 KiB block, and not a multiple of it, so the last
        // data block is short and the EOF still follows it.
        var payload = "x".repeat(32 * 1024) + "y".repeat(11) + "\n";
        try (var worker = Worker.start(payload, "")) {
            var transport = worker.transport();
            var channel = worker.begin(transport);
            var stdout = worker.copy(transport, channel, "stdout");

            assertEquals(payload, stdout.bytes);
            assertEquals(List.of(false, false, true), stdout.eofs);
            worker.copy(transport, channel, "stderr");
            assertEquals("drained", worker.stopDrained(transport));
        }
    }

    @Test
    @Timeout(60)
    void renewsTheChannelHorizonForwardSoALongCommandOutlivesOneLease() throws Exception {
        try (var worker = Worker.start("witness\n", "")) {
            var transport = worker.transport();
            // A horizon only a moment away, as a writer lease about to lapse.
            var channel = worker.begin(transport, System.currentTimeMillis() + 2_000);
            long extended = System.currentTimeMillis() + 600_000;
            transport.externalPublicationRenew(worker.lease, worker.request, worker.seed,
                    REVISION, channel, extended).toCompletableFuture().join();

            // A stale renewal must not shorten the live channel. Its horizon is
            // already past by the time the copy runs, so a channel that took it
            // would be closed mid-command and no drain could ever finish.
            transport.externalPublicationRenew(worker.lease, worker.request, worker.seed,
                    REVISION, channel, System.currentTimeMillis() - 1_000)
                    .toCompletableFuture().join();
            assertEquals("witness\n", worker.copy(transport, channel, "stdout").bytes);
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
        try (var worker = Worker.start("witness\n", "")) {
            var transport = worker.transport();
            var channel = worker.begin(transport);
            // Read both of stdout's sequences but acknowledge only the data
            // block. The EOF was delivered and never acked, so the bytes are
            // still owed and the stop must refuse to claim a drained lane.
            transport.externalPublicationRead(worker.lease, worker.request, worker.seed,
                    REVISION, channel, "stdout", 0, 0).toCompletableFuture().join();
            transport.externalPublicationRead(worker.lease, worker.request, worker.seed,
                    REVISION, channel, "stdout", 1, 0).toCompletableFuture().join();

            assertEquals("undrained", worker.stopDrained(transport));
        }
    }

    @Test
    @Timeout(60)
    void aFutureAcknowledgementIsRefusedBeforeItCanSkipUndeliveredBytes() throws Exception {
        try (var worker = Worker.start("witness\n", "")) {
            var transport = worker.transport();
            var channel = worker.begin(transport);
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
        try (var worker = Worker.start("witness\n", "")) {
            var transport = worker.transport();
            // The probe names a channel that cannot exist. The worker's own
            // closed-lane refusal is the positive answer.
            assertTrue(transport.externalPublicationReady(worker.lease, worker.request,
                    worker.seed, REVISION).toCompletableFuture().join());
        }
        // A dead worker is absence of evidence, never evidence that it is gone:
        // readiness must be false rather than an exception the caller reads as
        // a retired generation.
        var dead = Worker.start("witness\n", "");
        var transport = dead.transport();
        dead.close();
        assertFalse(transport.externalPublicationReady(dead.lease, dead.request,
                dead.seed, REVISION).toCompletableFuture().join());
    }

    @Test
    @Timeout(60)
    void aForeignLeaseOrIncarnationNeverReachesTheCapture() throws Exception {
        try (var worker = Worker.start("secret output\n", "")) {
            var transport = worker.transport();
            var channel = worker.begin(transport);
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
        try (var worker = Worker.start("witness\n", "", "--never-ready")) {
            var transport = worker.transport();
            var channel = worker.begin(transport);
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
        var worker = Worker.start("witness\n", "");
        var transport = worker.transport(Duration.ofSeconds(2));
        var channel = worker.begin(transport);
        // A vanished worker mid-copy: the exchange must end on its own timeout
        // rather than pin the drain's carrier for ever.
        worker.close();
        var failure = assertThrows(CompletionException.class, () ->
                transport.externalPublicationRead(worker.lease, worker.request, worker.seed,
                        REVISION, channel, "stdout", 0, -1).toCompletableFuture().join());
        assertNotNull(failure.getCause());
    }

    private record Copied(String bytes, List<Boolean> eofs) { }

    /**
     * The worker stand-in as a real OS process: boot on stdin, its ready line on
     * stdout, then its publication protocol over loopback HTTP. The lease and
     * seed are derived from the same boot document, so the identity the Broker
     * pins is the one the worker checks.
     */
    private static final class Worker implements AutoCloseable {
        private static final String TOKEN = "worker-token-1234567890";
        private static final Map<String, Object> REFERENCE = Map.of(
                "sessionId", "runtime", "promptId", "turn", "callId", "call",
                "argsDigest", "sha256:" + "b".repeat(64));
        private static final Map<String, Object> CAPTURE = Map.of(
                "tenantId", "tenant", "sessionId", "harness", "turnId", "turn",
                "executionCallId", "execution", "bindingGeneration", "1",
                "capturePolicy", "complete_required");

        private final Process process;
        private final RuntimeScope scope = new RuntimeScope("tenant", "storage", "1", "/workspace",
                WorkspaceExecutionProfile.EXTERNAL_SHELL_CAPABILITY_DIGEST, "session");
        private final RuntimeProvisionRequest request = new RuntimeProvisionRequest(
                scope, "harness", ExternalWorkspaceProvisioner.KIND, "storage");
        private final RuntimeProvisionSeed seed = new RuntimeProvisionSeed(
                "provision-1", "runtime-instance", "incarnation-1", "lease-1", 1, TOKEN);
        private final RuntimeLease lease;

        private Worker(Process process, URI origin) {
            this.process = process;
            lease = new RuntimeLease(seed.getProvisionalRuntimeId(), origin,
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        }

        private static Worker start(String stdout, String stderr, String... extra) throws IOException {
            LocalProcessRuntimeProvisionerTest.requireNode();
            var script = Path.of("src/test/resources/external-shell-worker.mjs").toAbsolutePath();
            assumeTrue(Files.isRegularFile(script), "The worker stand-in is required");
            var command = new ArrayList<>(List.of("node", script.toString(),
                    "--stdout=" + stdout, "--stderr=" + stderr));
            command.addAll(List.of(extra));
            var process = new ProcessBuilder(command).redirectErrorStream(false).start();
            var boot = new LinkedHashMap<String, Object>();
            boot.put("type", "boot");
            boot.put("version", 2);
            boot.put("managedContext", "managed-context/1");
            boot.put("runtimeInstanceId", "runtime-instance");
            boot.put("runtimeIncarnation", "incarnation-1");
            boot.put("leaseId", "lease-1");
            boot.put("epoch", 1);
            boot.put("provisionRequestId", "provision-1");
            boot.put("token", TOKEN);
            boot.put("tenantId", "tenant");
            boot.put("workspaceId", "storage");
            boot.put("workspaceGeneration", "1");
            boot.put("storageId", "storage");
            boot.put("mountRoot", "/workspace");
            boot.put("capabilityDigest", WorkspaceExecutionProfile.EXTERNAL_SHELL_CAPABILITY_DIGEST);
            boot.put("isolationClass", "session");
            try (OutputStream stdin = process.getOutputStream()) {
                stdin.write(JSON.writeValueAsBytes(boot));
            }
            var stdoutReader = new BufferedReader(new InputStreamReader(
                    process.getInputStream(), StandardCharsets.UTF_8));
            var ready = stdoutReader.readLine();
            if (ready == null) {
                process.destroyForcibly();
                throw new AssertionError("The worker never became ready");
            }
            try {
                return new Worker(process, URI.create(JSON.readTree(ready).get("url").asText()));
            } catch (RuntimeException invalid) {
                process.destroyForcibly();
                throw invalid;
            }
        }

        private HttpRuntimeTransport transport() {
            return new HttpRuntimeTransport();
        }

        private HttpRuntimeTransport transport(Duration requestTimeout) {
            var client = java.net.http.HttpClient.newBuilder()
                    .version(java.net.http.HttpClient.Version.HTTP_1_1)
                    .followRedirects(java.net.http.HttpClient.Redirect.NEVER)
                    .connectTimeout(Duration.ofSeconds(5))
                    .build();
            try {
                var constructor = HttpRuntimeTransport.class.getDeclaredConstructor(
                        java.net.http.HttpClient.class, Duration.class);
                constructor.setAccessible(true);
                return constructor.newInstance(client, requestTimeout);
            } catch (ReflectiveOperationException unavailable) {
                throw new IllegalStateException("Cannot bound the transport timeout", unavailable);
            }
        }

        private String begin(HttpRuntimeTransport transport) {
            return begin(transport, System.currentTimeMillis() + 600_000);
        }

        private String begin(HttpRuntimeTransport transport, long expiresAt) {
            return transport.externalPublicationBegin(lease, request, seed, REVISION,
                    REFERENCE, CAPTURE, expiresAt, "capture-a").toCompletableFuture().join();
        }

        /**
         * The Broker's own copy cursor: read a sequence, acknowledge it by
         * re-reading it, and stop at the EOF. Every receipt is validated by the
         * transport, including the block digest and the EOF carrying no bytes.
         */
        private Copied copy(HttpRuntimeTransport transport, String channel, String stream) {
            var bytes = new StringBuilder();
            var eofs = new ArrayList<Boolean>();
            for (long sequence = 0; sequence < 1024; sequence++) {
                var answer = transport.externalPublicationRead(lease, request, seed, REVISION,
                        channel, stream, sequence, sequence).toCompletableFuture().join();
                assertEquals("ready", answer.get("state"));
                var block = (byte[]) answer.get("bytes");
                bytes.append(new String(block, StandardCharsets.UTF_8));
                boolean eof = (Boolean) answer.get("eof");
                eofs.add(eof);
                assertEquals(block.length == 0, eof, "Only the EOF carries no bytes");
                if (eof) {
                    return new Copied(bytes.toString(), eofs);
                }
            }
            throw new AssertionError("The stream never reached its EOF: " + stream);
        }

        private String stopDrained(HttpRuntimeTransport transport) {
            return drainState(transport, lease);
        }

        /** Reads the drained state past the transport's own void validator. */
        private String drainState(HttpRuntimeTransport transport, RuntimeLease used) {
            var stop = post("stop-drained", Map.of("protocolVersion", 2, "channel", "all"), used);
            return stop.get("state").asText();
        }

        private List<JsonNode> routes(String route) {
            var recorded = post("requests", Map.of("protocolVersion", 2), lease);
            var found = new ArrayList<JsonNode>();
            for (var entry : recorded.get("requests")) {
                if (route.equals(entry.get("route").asText())) {
                    found.add(entry.get("body"));
                }
            }
            return found;
        }

        /** A direct exchange, for the answers the transport deliberately drops. */
        private JsonNode post(String route, Map<String, Object> body, RuntimeLease used) {
            try {
                var request = java.net.http.HttpRequest.newBuilder(
                                lease.getEndpoint().resolve(
                                        "/internal/managed-runtime/v2/publication:" + route))
                        .timeout(Duration.ofSeconds(10))
                        .header("Authorization", "Bearer " + used.getToken())
                        .header("Cache-Control", "no-store")
                        .header("Content-Type", "application/json")
                        .header("X-Qwen-Managed-Lease-Id", used.getLeaseId())
                        .header("X-Qwen-Managed-Lease-Epoch", Long.toString(used.getEpoch()))
                        .header("X-Qwen-Managed-Storage-Revision", Long.toString(REVISION))
                        .header("X-Qwen-Managed-Runtime-Incarnation", seed.getGatewayIncarnation())
                        .POST(java.net.http.HttpRequest.BodyPublishers.ofByteArray(
                                JSON.writeValueAsBytes(body)))
                        .build();
                var response = java.net.http.HttpClient.newHttpClient().send(request,
                        java.net.http.HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                assertEquals(200, response.statusCode(), response.body());
                return JSON.readTree(response.body());
            } catch (IOException failure) {
                throw new AssertionError("The worker exchange failed", failure);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new AssertionError("The worker exchange was interrupted", interrupted);
            }
        }

        @Override
        public void close() {
            process.destroy();
            try {
                if (!process.waitFor(10, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            }
        }
    }
}
