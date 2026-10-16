package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

@DisabledOnOs(OS.WINDOWS)
class SshRuntimeProvisionerTest {
    @TempDir
    Path controlDirectory;
    private static final SshRuntimeNode NODE = new SshRuntimeNode("mac", "Mac", "worker-mac",
            "/opt/node", "/opt/qwen/cli.js", "/var/tmp/qwen-worker", List.of("/workspace"), 34561);
    private static final SshRuntimeStorage STORAGE = new SshRuntimeStorage("mac", "storage:a", "/workspace/project",
            Map.of("qwenVersion", "0.25.1", "identity", Map.of("root", "/workspace/project", "hostId", "host", "device", "1", "inode", "2",
                    "birthTime", "3"), "marker", Map.of("version", 2, "tenantId", "tenant", "storageId", "storage:a",
                    "root", "/workspace/project", "hostId", "host", "device", "1", "inode", "2", "birthTime", "3",
                    "registrationId", "registered")));
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant", "workspace", "1", "/workspace/project",
            WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
    private final List<Map<String, Object>> commands = new ArrayList<>();
    private Map<String, Object> boot;
    private String state = "INTENT";
    private int startingObservations;
    private boolean corruptProof;
    private HttpServer server;
    private HttpRuntimeTransport transport;
    private SshConnectionManager connections;
    private SshRuntimeProvisioner provisioner;

    @BeforeEach
    void setUp() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/internal/managed-runtime/v3/attest", exchange -> {
            assertEquals("Bearer " + boot.get("token"), exchange.getRequestHeaders().getFirst("Authorization"));
            exchange.getRequestBody().readAllBytes();
            byte[] response = JsonCodec.encode(ManagedContextProtocol.attestationResponse(boot));
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        URI endpoint = URI.create("http://127.0.0.1:" + server.getAddress().getPort());
        transport = new HttpRuntimeTransport(ignored -> endpoint);
        connections = new SshConnectionManager(URI.create("http://127.0.0.1:8080/publications"), controlDirectory,
                (command, input, timeout) -> {
                    if (input.length == 0) {
                        return new SshConnectionManager.CommandResult(0, new byte[0]);
                    }
                    Map<String, Object> request = JsonCodec.parseObject(input, "test request");
                    commands.add(request);
                    String operation = (String) request.get("operation");
                    if (operation.equals("ensure")) {
                        boot = ProviderRuntimeProtocol.object(request.get("boot"));
                        if (Boolean.TRUE.equals(request.get("launch"))) {
                            state = startingObservations == 0 ? "READY" : "STARTING";
                        }
                    }
                    if (operation.equals("observe") && startingObservations > 0 && --startingObservations == 0) {
                        state = "READY";
                    }
                    Map<String, Object> result = new LinkedHashMap<>();
                    result.put("resourceId", request.get("resourceId"));
                    if (operation.equals("stop")) {
                        state = "RETIRED";
                        Map<String, Object> proof = new LinkedHashMap<>();
                        proof.put("version", 1);
                        proof.put("resourceId", request.get("resourceId"));
                        proof.put("bindingId", boot.get("runtimeInstanceId"));
                        proof.put("bindingGeneration", boot.get("epoch"));
                        for (String key : List.of("provisionRequestId", "runtimeInstanceId", "runtimeIncarnation",
                                "leaseId", "epoch")) {
                            proof.put(key, boot.get(key));
                        }
                        proof.put("retirementId", corruptProof ? "wrong" : request.get("retirementId"));
                        proof.put("retiredAt", Instant.now().toString());
                        result.put("cleanProof", proof);
                    }
                    result.put("state", state);
                    result.put("pid", state.equals("READY") ? 4321 : null);
                    result.put("ready", state.equals("READY") ? ready() : null);
                    return new SshConnectionManager.CommandResult(0,
                            JsonCodec.encode(Map.of("protocolVersion", 1, "ok", true, "result", result)));
                });
        provisioner = provisioner();
    }

    @AfterEach
    void tearDown() {
        provisioner.close();
        server.stop(0);
    }

    @Test
    void boundsConcurrentControlWorkAndReturnsRetryableOverload() throws Exception {
        var entered = new CountDownLatch(4);
        var release = new CountDownLatch(1);
        try (var manager = new SshConnectionManager(URI.create("http://127.0.0.1:8080"),
                controlDirectory.resolve("bounded"), (command, input, timeout) -> {
                    if (input.length == 0) return new SshConnectionManager.CommandResult(0, new byte[0]);
                    entered.countDown();
                    try {
                        if (!release.await(5, TimeUnit.SECONDS)) throw new AssertionError("Controls were not released");
                    } catch (InterruptedException failure) {
                        Thread.currentThread().interrupt();
                        throw new AssertionError(failure);
                    }
                    var request = JsonCodec.parseObject(input, "bounded control");
                    return new SshConnectionManager.CommandResult(0, JsonCodec.encode(Map.of("protocolVersion", 1,
                            "ok", true, "result", Map.of("resourceId", request.get("resourceId"), "state", "INTENT"))));
                }); var limited = new SshRuntimeProvisioner(ignored -> NODE, ignored -> STORAGE, manager, transport)) {
            var request = limited.createRequest(SCOPE, "session");
            var controls = new ArrayList<CompletionStage<RuntimeResourceHandle>>();
            try {
                for (int i = 0; i < 4; i++) {
                    controls.add(limited.ensureResource(request, RuntimeProvisionSeed.create("active-" + i, 1), null));
                }
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                for (int i = 0; i < 64; i++) {
                    controls.add(limited.ensureResource(request, RuntimeProvisionSeed.create("queued-" + i, 1), null));
                }
                var overflow = limited.ensureResource(request, RuntimeProvisionSeed.create("overflow", 1), null);
                var failure = assertThrows(ExecutionException.class, () -> await(overflow));
                var unavailable = (RuntimeBrokerException) failure.getCause();
                assertEquals("ssh_runtime_busy", unavailable.getCode());
                assertTrue(unavailable.isRetryable());
            } finally {
                release.countDown();
            }
            for (var control : controls) await(control);
        }
    }

    @Test
    void closingCompletesQueuedControlsInsteadOfAbandoningTheirFutures() throws Exception {
        var entered = new CountDownLatch(4);
        var release = new CountDownLatch(1);
        var lease = new RuntimeLease("runtime", URI.create("http://127.0.0.1:41234"), "token", "lease", 1);
        try (var manager = new SshConnectionManager(URI.create("http://127.0.0.1:8080"),
                controlDirectory.resolve("closing"), (command, input, timeout) -> {
                    if (input.length == 0) return new SshConnectionManager.CommandResult(0, new byte[0]);
                    entered.countDown();
                    try {
                        if (!release.await(5, TimeUnit.SECONDS)) throw new AssertionError("Controls were not released");
                    } catch (InterruptedException failure) {
                        Thread.currentThread().interrupt();
                        throw new AssertionError(failure);
                    }
                    var request = JsonCodec.parseObject(input, "closing control");
                    return new SshConnectionManager.CommandResult(0, JsonCodec.encode(Map.of("protocolVersion", 1,
                            "ok", true, "result", Map.of("resourceId", request.get("resourceId"), "state", "INTENT"))));
                }); var limited = new SshRuntimeProvisioner(ignored -> NODE, ignored -> STORAGE, manager, transport)) {
            var request = limited.createRequest(SCOPE, "session");
            var controls = new ArrayList<CompletionStage<Void>>();
            try {
                for (int i = 0; i < 4; i++) {
                    limited.ensureResource(request, RuntimeProvisionSeed.create("active-" + i, 1), null);
                }
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                for (int i = 0; i < 8; i++) controls.add(limited.confirm(request, lease));
                var closing = CompletableFuture.runAsync(limited::close);
                try {
                    assertTimeoutPreemptively(Duration.ofSeconds(2), () -> {
                        while (true) {
                            try {
                                manager.registerDirect(lease);
                            } catch (RuntimeBrokerException closed) {
                                assertEquals("ssh_runtime_unavailable", closed.getCode());
                                return;
                            }
                            Thread.sleep(1);
                        }
                    });
                } finally {
                    release.countDown();
                }
                closing.get(3, TimeUnit.SECONDS);
                for (var control : controls) assertThrows(ExecutionException.class, () -> await(control));
            } finally {
                release.countDown();
            }
        }
    }

    @Test
    void persistsIntentBeforeLaunchAndKeepsTheRemoteLeaseOrigin() throws Exception {
        var request = provisioner.createRequest(SCOPE, "session");
        var seed = RuntimeProvisionSeed.create("binding", 1);
        var handle = await(provisioner.ensureResource(request, seed, null));
        assertEquals("ssh-process", handle.getKind());
        assertEquals(false, commands.getFirst().get("launch"));
        assertEquals("INTENT", state);
        assertFalse(handle.toJson().contains(seed.getToken()));
        var lease = await(provisioner.provision(request, seed));
        assertEquals(URI.create("http://127.0.0.1:30001/"), lease.getEndpoint());
        assertEquals(true, commands.getLast().get("launch"));
        await(provisioner.release(request, lease));
        assertTrue(provisioner.isUsable(lease));
        await(provisioner.confirm(request, lease));
        assertEquals(2, commands.size());
    }

    @Test
    void waitsForOnlyTheOriginalSlowStartupAndNeverRepeatsItsLaunch() throws Exception {
        var request = provisioner.createRequest(SCOPE, "session");
        var seed = RuntimeProvisionSeed.create("binding", 1);
        var handle = await(provisioner.ensureResource(request, seed, null));
        startingObservations = 2;
        var lease = await(provisioner.provision(request, seed));
        assertTrue(provisioner.isUsable(lease));
        assertEquals(1, commands.stream().filter(command -> Boolean.TRUE.equals(command.get("launch"))).count());
        assertEquals(2, commands.stream().filter(command -> "observe".equals(command.get("operation"))).count());
        state = "STARTING";
        startingObservations = 2;
        try (var observer = provisioner()) {
            assertEquals(RuntimeObservation.Outcome.READY, await(observer.reconcile(request, seed, handle, lease)).getOutcome());
            assertEquals(1, commands.stream().filter(command -> Boolean.TRUE.equals(command.get("launch"))).count());
        }
    }

    @Test
    void observesOriginalStartupWithoutLaunchingOrReplacingIt() throws Exception {
        var request = provisioner.createRequest(SCOPE, "session");
        var seed = RuntimeProvisionSeed.create("binding", 1);
        var handle = await(provisioner.ensureResource(request, seed, null));
        var lease = await(provisioner.provision(request, seed));
        try (var observer = provisioner()) {
            var restored = await(observer.reconcile(request, seed, handle, lease));
            assertEquals(RuntimeObservation.Outcome.READY, restored.getOutcome());
            assertEquals(lease.getEndpoint(), restored.getEndpoint());
            assertEquals("observe", commands.getLast().get("operation"));
            assertEquals(1, commands.stream().filter(command -> Boolean.TRUE.equals(command.get("launch"))).count());
        }
    }

    @Test
    void aProvenFailedLaunchCannotBeReplacedButCanBeRetiredWithoutALease() throws Exception {
        var bindings = new InMemoryRuntimeBindingRepository();
        var request = provisioner.createRequest(SCOPE, "session");
        var original = bindings.findOrCreate(request);
        var claim = bindings.claimOperation(original.getBindingId(), "owner", Duration.ofMinutes(1));
        var seed = claim.getProvisionSeed();
        var handle = await(provisioner.ensureResource(request, seed, null));
        state = "FAILED";
        var error = assertThrows(ExecutionException.class,
                () -> await(provisioner.reconcile(request, seed, handle, null)));
        assertEquals("ssh_runtime_launch_failed", ((RuntimeBrokerException) error.getCause()).getCode());
        assertFalse(((RuntimeBrokerException) error.getCause()).isRetryable());
        var draining = claim.withDrainRequested(true, Instant.now())
                .withState(RuntimeBindingRecord.State.DRAINING, null, Instant.now());
        assertTrue(await(provisioner.stopDrained(draining)).matches(draining));
        assertFalse(commands.stream().anyMatch(command -> Boolean.TRUE.equals(command.get("launch"))));
    }

    @Test
    void interruptedOrKilledWorkerDoesNotProduceStopEvidenceOrAnotherLaunch() throws Exception {
        var request = provisioner.createRequest(SCOPE, "session");
        var seed = RuntimeProvisionSeed.create("binding", 1);
        var handle = await(provisioner.ensureResource(request, seed, null));
        state = "INTENT";
        assertEquals(RuntimeObservation.Outcome.STARTING,
                await(provisioner.reconcile(request, seed, handle, null)).getOutcome());
        state = "BLOCKED";
        ExecutionException error = assertThrows(ExecutionException.class,
                () -> await(provisioner.reconcile(request, seed, handle, null)));
        assertEquals("ssh_runtime_recovery_blocked", ((RuntimeBrokerException) error.getCause()).getCode());
        assertFalse(commands.stream().anyMatch(command -> Boolean.TRUE.equals(command.get("launch"))));
    }

    @Test
    void verifiesEveryOriginalIdentityBeforeAcceptingCleanRetirement() throws Exception {
        var bindings = new InMemoryRuntimeBindingRepository();
        var request = provisioner.createRequest(SCOPE, "session");
        var original = bindings.findOrCreate(request);
        var claim = bindings.claimOperation(original.getBindingId(), "owner", Duration.ofMinutes(1));
        var seed = claim.getProvisionSeed();
        var handle = await(provisioner.ensureResource(request, seed, null));
        var lease = await(provisioner.provision(request, seed));
        var ready = claim.withAttestation(lease, handle, Instant.now(), Instant.now());
        var draining = ready.withDrainRequested(true, Instant.now())
                .withState(RuntimeBindingRecord.State.DRAINING, lease, Instant.now());
        corruptProof = true;
        assertThrows(ExecutionException.class, () -> await(provisioner.stopDrained(draining)));
        assertTrue(provisioner.isUsable(lease), "failed proof cannot mark the original worker stopped");
        corruptProof = false;
        var receipt = await(provisioner.stopDrained(draining));
        assertTrue(receipt.matches(draining));
        assertFalse(provisioner.isUsable(lease));
        assertEquals(commands.get(commands.size() - 2).get("retirementId"), commands.getLast().get("retirementId"));
    }

    @Test
    void rejectsChangedRegistrationForeignKindAndWorkspaceIsolation() throws Exception {
        var request = provisioner.createRequest(SCOPE, "session");
        var seed = RuntimeProvisionSeed.create("binding", 1);
        var handle = await(provisioner.ensureResource(request, seed, null));
        var changed = new LinkedHashMap<>(handle.getValue());
        changed.put("nodeId", "other-node");
        assertThrows(ExecutionException.class, () -> await(provisioner.ensureResource(request, seed,
                new RuntimeResourceHandle(SshRuntimeProvisioner.KIND, 1, changed))));
        assertFalse(provisioner.supportsStartupRecovery(new RuntimeResourceHandle("static", 1, Map.of())));
        assertThrows(RuntimeBrokerException.class, () -> provisioner.createRequest(new RuntimeScope("tenant", "workspace",
                "1", "/workspace/project", WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace"), null));
        assertEquals(1, commands.size());
    }

    private SshRuntimeProvisioner provisioner() {
        return new SshRuntimeProvisioner(id -> id.equals(NODE.nodeId()) ? NODE : null, scope -> STORAGE,
                connections, transport);
    }

    private Map<String, Object> ready() {
        return Map.of("type", "ready", "version", 2, "managedContext", "managed-context/1",
                "runtimeInstanceId", boot.get("runtimeInstanceId"), "runtimeIncarnation", boot.get("runtimeIncarnation"),
                "leaseId", boot.get("leaseId"), "epoch", boot.get("epoch"), "url", "http://127.0.0.1:30001");
    }

    private static <T> T await(CompletionStage<T> stage) throws Exception {
        return stage.toCompletableFuture().get(5, TimeUnit.SECONDS);
    }
}
