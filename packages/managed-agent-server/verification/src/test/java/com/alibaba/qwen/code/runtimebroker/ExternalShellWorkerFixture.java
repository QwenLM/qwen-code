package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.provisioning.external.ExternalWorkspaceProvisioner;
import com.alibaba.qwen.code.runtimebroker.provisioning.local.LocalProcessRuntimeProvisionerTest;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The external foreground-Shell worker stand-in as a real OS process (#15512
 * slice C): boot on stdin, its ready line on stdout, then its publication
 * protocol over loopback HTTP.
 *
 * <p>Two suites drive it. {@link ExternalShellWorkerProtocolTest} pins the wire
 * agreement by driving the transport directly;
 * {@code ExternalShellProducerPublicationTest} drives the producer over the
 * real control-plane stores. Both need the same process and the same identity,
 * so the boot document is built here once: the lease and seed are derived from
 * it, which is what makes the identity the Broker pins the one the worker
 * checks.
 *
 * <p>A caller that has its own attested binding passes that seed instead, so
 * the worker answers for the binding the repositories actually saved.
 */
public final class ExternalShellWorkerFixture implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TOKEN = "worker-token-1234567890";

    /** One captured stream, as the copy cursor observed it. */
    public record Copied(String bytes, List<Boolean> eofs) { }

    public final Process process;
    public final RuntimeScope scope;
    public final RuntimeProvisionRequest request;
    public final RuntimeProvisionSeed seed;
    public final RuntimeLease lease;
    public final long revision;

    private ExternalShellWorkerFixture(Process process, URI origin, RuntimeProvisionSeed seed,
            RuntimeScope scope, RuntimeProvisionRequest request, long revision) {
        this.process = process;
        this.seed = seed;
        this.scope = scope;
        this.request = request;
        this.revision = revision;
        lease = new RuntimeLease(seed.getProvisionalRuntimeId(), origin,
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
    }

    /** A worker for a stand-alone placement the caller does not persist. */
    public static ExternalShellWorkerFixture start(String stdout, String stderr, String... extra)
            throws IOException {
        var scope = new RuntimeScope("tenant", "storage", "1", "/workspace",
                WorkspaceExecutionProfile.EXTERNAL_SHELL_CAPABILITY_DIGEST, "session");
        var request = new RuntimeProvisionRequest(scope, "harness",
                ExternalWorkspaceProvisioner.KIND, "storage");
        var seed = new RuntimeProvisionSeed("provision-1", "runtime-instance",
                "incarnation-1", "lease-1", 1, TOKEN);
        return boot(stdout, stderr, seed, request, 1, extra);
    }

    /**
     * A worker that answers for an already attested binding: the boot document
     * carries the saved seed and scope, so the producer's own revision and
     * identity headers are the ones this process accepts.
     */
    public static ExternalShellWorkerFixture start(RuntimeBindingRecord binding, long revision,
            String stdout, String stderr, String... extra) throws IOException {
        return boot(stdout, stderr, binding.getProvisionSeed(), binding.getRequest(), revision, extra);
    }

    static void requireWindowsSafeCommandLine(List<String> command) {
        // Windows CreateProcess caps the whole command line at 32767
        // characters including the terminating NUL, so 32766 is the
        // longest join that can ever launch: a capture payload must ride
        // the boot document instead of an argument — the large-capture
        // case alone is 32780 characters (#17885).
        var joined = String.join(" ", command);
        if (joined.length() > 32_766) {
            throw new AssertionError("The worker command line is "
                    + joined.length() + " characters, over the Windows"
                    + " CreateProcess limit of 32767 including the terminating"
                    + " NUL; pass capture payloads in the boot document, not"
                    + " as arguments");
        }
    }

    private static ExternalShellWorkerFixture boot(String stdout, String stderr,
            RuntimeProvisionSeed seed, RuntimeProvisionRequest request, long revision,
            String... extra) throws IOException {
        LocalProcessRuntimeProvisionerTest.requireNode();
        var script = Path.of("src/test/resources/external-shell-worker.mjs").toAbsolutePath();
        assumeTrue(Files.isRegularFile(script), "The worker stand-in is required");
        var command = new ArrayList<>(List.of("node", script.toString(),
                "--storage-revision=" + revision));
        command.addAll(List.of(extra));
        requireWindowsSafeCommandLine(command);
        var process = new ProcessBuilder(command).redirectErrorStream(false).start();
        var scope = request.getScope();
        var boot = new LinkedHashMap<String, Object>();
        boot.put("type", "boot");
        boot.put("version", 2);
        boot.put("managedContext", "managed-context/1");
        boot.put("runtimeInstanceId", seed.getProvisionalRuntimeId());
        boot.put("runtimeIncarnation", seed.getGatewayIncarnation());
        boot.put("leaseId", seed.getLeaseId());
        boot.put("epoch", seed.getEpoch());
        boot.put("provisionRequestId", seed.getProvisionRequestId());
        boot.put("token", seed.getToken());
        boot.put("tenantId", scope.getTenantId());
        boot.put("workspaceId", scope.getWorkspaceId());
        boot.put("workspaceGeneration", scope.getWorkspaceGeneration());
        boot.put("storageId", request.getStorageId());
        boot.put("mountRoot", scope.getCanonicalCwd());
        boot.put("capabilityDigest", scope.getCapabilityDigest());
        boot.put("isolationClass", scope.getIsolationClass());
        // The captured stream payloads ride the boot document, never argv: a
        // capture payload can exceed the whole Windows CreateProcess
        // command-line limit of 32767 characters, which no argument survives
        // (#17885).
        boot.put("stdout", stdout);
        boot.put("stderr", stderr);
        try (OutputStream stdin = process.getOutputStream()) {
            stdin.write(JSON.writeValueAsBytes(boot));
        }
        var reader = new BufferedReader(new InputStreamReader(
                process.getInputStream(), StandardCharsets.UTF_8));
        var ready = reader.readLine();
        if (ready == null) {
            process.destroyForcibly();
            throw new AssertionError("The worker never became ready");
        }
        try {
            return new ExternalShellWorkerFixture(process,
                    URI.create(JSON.readTree(ready).get("url").asText()),
                    seed, scope, request, revision);
        } catch (RuntimeException invalid) {
            process.destroyForcibly();
            throw invalid;
        }
    }

    public HttpRuntimeTransport transport() {
        return new HttpRuntimeTransport();
    }

    public HttpRuntimeTransport transport(Duration requestTimeout) {
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

    /**
     * The Broker's own copy cursor: read a sequence, acknowledge it by
     * reading the next sequence with it as the lagged ack, and stop at the EOF.
     * An ack-on-first-read is the shape the shipped worker refuses (the ack
     * would exceed the delivered cursor), so the cursor acks sequence N-1 while
     * reading sequence N. The final EOF is acked by a no-op re-read of the EOF
     * sequence. Every receipt is validated by the transport, including the
     * block digest and the EOF carrying no bytes.
     */
    public Copied copy(HttpRuntimeTransport transport, String channel, String stream) {
        var bytes = new java.io.ByteArrayOutputStream();
        var eofs = new ArrayList<Boolean>();
        long acked = -1;
        for (long sequence = 0; sequence < 1024; sequence++) {
            var answer = transport.externalPublicationRead(lease, request, seed, revision,
                    channel, stream, sequence, acked).toCompletableFuture().join();
            assertEquals("ready", answer.get("state"));
            var block = (byte[]) answer.get("bytes");
            // A multi-byte character may straddle a block boundary, so the
            // bytes are accumulated raw and decoded once at the end.
            bytes.writeBytes(block);
            boolean eof = (Boolean) answer.get("eof");
            eofs.add(eof);
            assertEquals(block.length == 0, eof, "Only the EOF carries no bytes");
            if (eof) {
                // Re-read the EOF sequence with the ack that covers it: the
                // shipped worker's `stop-drained` requires every stream's EOF
                // to be acknowledged, and an EOF arrives as its own sequence.
                transport.externalPublicationRead(lease, request, seed, revision,
                        channel, stream, sequence, sequence).toCompletableFuture().join();
                return new Copied(bytes.toString(StandardCharsets.UTF_8), eofs);
            }
            acked = sequence;
        }
        throw new AssertionError("The stream never reached its EOF: " + stream);
    }

    public String stopDrained(HttpRuntimeTransport transport) {
        try {
            transport.stopExternalWorkspaceDrained(lease, request, seed, revision)
                    .toCompletableFuture().join();
            return "drained";
        } catch (java.util.concurrent.CompletionException refused) {
            if (refused.getCause() instanceof RuntimeBrokerException failure
                    && failure.getStatusCode() == 503
                    && "managed_runtime_unavailable".equals(failure.getCode())) {
                return "undrained";
            }
            throw refused;
        }
    }

    public List<JsonNode> routes(String route) {
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
    public JsonNode post(String route, Map<String, Object> body, RuntimeLease used) {
        var response = exchange(route, body, used);
        assertEquals(200, response.statusCode(), response.body());
        try {
            return JSON.readTree(response.body());
        } catch (IOException failure) {
            throw new AssertionError("The worker exchange failed", failure);
        }
    }

    /**
     * A direct exchange that surfaces the worker's own refusal (status and
     * closed body) instead of asserting 200, for the cursor rules the
     * transport refuses locally before any request leaves this process.
     */
    public RuntimeBrokerException postRefused(String route, Map<String, Object> body,
            RuntimeLease used) {
        var response = exchange(route, body, used);
        try {
            var fields = JSON.readTree(response.body());
            return new RuntimeBrokerException(response.statusCode(),
                    fields.path("code").asText(), fields.path("error").asText(), false);
        } catch (IOException failure) {
            throw new AssertionError("The worker exchange failed", failure);
        }
    }

    /**
     * The worker's own answer to a begin this fixture holds the full capture
     * shape for, including a refusal, for the identity fences the transport
     * validates only on success.
     */
    public java.net.http.HttpResponse<String> beginRaw(Map<String, Object> reference,
            Map<String, Object> capture, long expiresAt, String captureId) {
        return exchange("begin", Map.of("protocolVersion", 2, "reference", reference,
                "capture", capture, "expiresAt", expiresAt, "captureId", captureId), lease);
    }

    /**
     * The stop-drained refusal the real transport throws, for cases that must
     * prove the worker itself rejected the stop rather than merely answering
     * undrained.
     */
    public RuntimeBrokerException stopDrainedRefusal(HttpRuntimeTransport transport) {
        try {
            transport.stopExternalWorkspaceDrained(lease, request, seed, revision)
                    .toCompletableFuture().join();
            throw new AssertionError("The drained stop was not refused");
        } catch (java.util.concurrent.CompletionException refused) {
            if (refused.getCause() instanceof RuntimeBrokerException failure) {
                return failure;
            }
            throw refused;
        }
    }

    private java.net.http.HttpResponse<String> exchange(String route, Map<String, Object> body,
            RuntimeLease used) {
        try {
            var exchange = java.net.http.HttpRequest.newBuilder(
                            lease.getEndpoint().resolve(
                                    "/internal/managed-runtime/v2/publication:" + route))
                    .timeout(Duration.ofSeconds(10))
                    .header("Authorization", "Bearer " + used.getToken())
                    .header("Cache-Control", "no-store")
                    .header("Content-Type", "application/json")
                    .header("X-Qwen-Managed-Lease-Id", used.getLeaseId())
                    .header("X-Qwen-Managed-Lease-Epoch", Long.toString(used.getEpoch()))
                    .header("X-Qwen-Managed-Storage-Revision", Long.toString(revision))
                    .header("X-Qwen-Managed-Runtime-Incarnation", seed.getGatewayIncarnation())
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofByteArray(
                            JSON.writeValueAsBytes(body)))
                    .build();
            return java.net.http.HttpClient.newHttpClient().send(exchange,
                    java.net.http.HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
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
