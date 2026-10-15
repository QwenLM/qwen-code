package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
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
import java.util.concurrent.CompletionStage;
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
