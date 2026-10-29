package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.InMemoryRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.InMemoryToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeAttestation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.transport.HttpRuntimeTransport;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Opt-in loopback SSH acceptance using private keys, real bootstrap and real HTTP workers. */
@DisabledOnOs(OS.WINDOWS)
@EnabledIfSystemProperty(named = "qwen.ssh.interop", matches = "true")
class SshRuntimeInteropTest {
    @TempDir
    Path temporary;
    private Process sshd;
    private Process crashedBroker;
    private Path root;
    private Path sshConfig;
    private SshRuntimeNode node;
    private Path controlDirectory;
    private HttpServer publications;
    private final AtomicReference<Path> controlSocket = new AtomicReference<>();
    private final List<Long> workerPids = new ArrayList<>();
    private final AtomicInteger masterStarts = new AtomicInteger();

    @BeforeEach
    void setUp() throws Exception {
        root = temporary.toRealPath();
        controlDirectory = Files.createTempDirectory(Path.of("/tmp"), "qws-").toRealPath();
        Path repository = Path.of("").toAbsolutePath().resolve("../..").normalize();
        Path entry = repository.resolve("packages/cli/dist/index.js");
        assertTrue(Files.isRegularFile(entry), "Build the CLI before running SSH interop");
        String executable = command(List.of("node", "-p", "process.execPath")).strip();
        for (String key : List.of("host", "client")) {
            command(List.of("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", root.resolve(key).toString()));
        }
        int port = port();
        String user = System.getProperty("user.name");
        Path serverConfig = root.resolve("sshd.conf");
        Files.writeString(serverConfig, String.join("\n", "Port " + port, "ListenAddress 127.0.0.1",
                "HostKey " + root.resolve("host"), "PidFile " + root.resolve("sshd.pid"),
                "AuthorizedKeysFile " + root.resolve("client.pub"), "StrictModes yes", "PubkeyAuthentication yes",
                "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no", "PrintMotd no",
                "AllowUsers " + user, "LogLevel ERROR", "AllowTcpForwarding yes", "GatewayPorts no") + "\n");
        sshd = new ProcessBuilder("/usr/sbin/sshd", "-D", "-e", "-f", serverConfig.toString())
                .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(root.resolve("sshd.log").toFile()).start();
        for (int attempt = 0; attempt < 100; attempt++) {
            if (!sshd.isAlive()) {
                throw new AssertionError(Files.readString(root.resolve("sshd.log")));
            }
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress("127.0.0.1", port), 50);
                break;
            } catch (IOException ignored) {
                Thread.sleep(25);
            }
        }
        Files.writeString(root.resolve("known_hosts"), "qwen-ssh-interop " + Files.readString(root.resolve("host.pub")));
        sshConfig = root.resolve("ssh.conf");
        Files.writeString(sshConfig, String.join("\n", "Host qwen-ssh-interop", " HostName 127.0.0.1", " Port " + port,
                " User " + user, " IdentityFile " + root.resolve("client"), " IdentitiesOnly yes",
                " HostKeyAlias qwen-ssh-interop", " UserKnownHostsFile " + root.resolve("known_hosts"),
                " GlobalKnownHostsFile /dev/null", " StrictHostKeyChecking yes", " BatchMode yes") + "\n");
        Files.createDirectory(root.resolve("workspace"));
        Files.writeString(root.resolve("workspace/original.txt"), "real SSH workspace\n");
        node = new SshRuntimeNode("node", "Loopback SSH", "qwen-ssh-interop", executable, entry.toString(),
                root.resolve("state").toString(), List.of(root.resolve("workspace").toString()), port());
        publications = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        publications.createContext("/publications/probe", exchange -> {
            byte[] response = "reverse-publication-ok".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        publications.createContext("/internal/hosted-shell-publisher/v1", exchange -> {
            var body = JsonCodec.parseObject(exchange.getRequestBody().readAllBytes(), "publisher prepare");
            assertEquals("Bearer " + "A".repeat(43), exchange.getRequestHeaders().getFirst("Authorization"));
            Map<String, Object> reply;
            if ("prepare".equals(body.get("operation"))) {
                var request = ProviderRuntimeProtocol.object(body.get("request"));
                var capture = ProviderRuntimeProtocol.object(request.get("capture"));
                var reference = ProviderRuntimeProtocol.object(request.get("reference"));
                reply = Map.of("tenantId", capture.get("tenantId"), "sessionId", capture.get("sessionId"),
                        "turnId", capture.get("turnId"), "executionCallId", capture.get("executionCallId"),
                        "callId", reference.get("callId"), "invocationDigest", reference.get("argsDigest"),
                        "bindingGeneration", capture.get("bindingGeneration"), "captureId", "no-start-capture", "revision", 1);
            } else {
                assertEquals("finalize", body.get("operation"), "A no-start Shell must not write or accept captured output");
                assertEquals(false, body.get("started"));
                assertEquals(null, body.get("process"));
                assertEquals("not_started", body.get("executionStatus"));
                reply = new LinkedHashMap<>(Map.of("executionStatus", body.get("executionStatus"), "responseParts", body.get("responseParts")));
                reply.put("capture", null);
                if (body.get("error") != null) {
                    reply.put("error", body.get("error"));
                }
            }
            byte[] response = JsonCodec.encode(reply);
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        publications.start();
    }

    @AfterEach
    void tearDown() throws Exception {
        if (crashedBroker != null && crashedBroker.isAlive()) {
            crashedBroker.destroyForcibly();
            crashedBroker.waitFor(5, TimeUnit.SECONDS);
        }
        if (publications != null) {
            publications.stop(0);
        }
        Path resources = root == null ? null : root.resolve("state/resources");
        if (resources != null && Files.isDirectory(resources)) {
            try (var directories = Files.list(resources)) {
                for (Path directory : directories.toList()) {
                    Path pidFile = directory.resolve("pid.json");
                    if (Files.isRegularFile(pidFile)) {
                        Object pid = JsonCodec.parseObject(Files.readAllBytes(pidFile), "worker pid").get("pid");
                        if (pid instanceof Number number && !workerPids.contains(number.longValue())) {
                            workerPids.add(number.longValue());
                        }
                    }
                }
            }
        }
        for (long pid : workerPids) {
            var process = ProcessHandle.of(pid);
            if (process.isPresent() && process.get().isAlive() && process.get().info().arguments()
                    .map(arguments -> java.util.Arrays.stream(arguments).anyMatch(value -> value.startsWith(root.toString())))
                    .orElse(false)) {
                process.get().destroyForcibly();
                process.get().onExit().get(5, TimeUnit.SECONDS);
            }
        }
        if (controlDirectory != null && sshConfig != null && node != null) {
            try (var paths = Files.list(controlDirectory)) {
                for (Path socket : paths.filter(SshRuntimeInteropTest::controlSocket).toList()) {
                    SshConnectionManager.runCommand(List.of("ssh", "-F", sshConfig.toString(), "-S", socket.toString(),
                            "-O", "exit", node.sshHost()), new byte[0], Duration.ofSeconds(5));
                }
            }
        }
        if (sshd != null && sshd.isAlive()) {
            sshd.destroy();
            if (!sshd.waitFor(5, TimeUnit.SECONDS)) {
                sshd.destroyForcibly();
            }
        }
        if (controlDirectory != null) {
            try (var paths = Files.walk(controlDirectory)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
                    Files.deleteIfExists(path);
                }
            }
        }
    }

    @Test
    void aNewBrokerAdoptsTheLiveMasterAfterTheOldJvmHaltsWithoutShutdownHooks() throws Exception {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        SshRuntimeStorage storage;
        RuntimeProvisionRequest request;
        RuntimeBindingRecord saved;
        Map<String, Object> launch;
        try (var connections = connections()) {
            storage = registerStorage(connections);
            var scope = new RuntimeScope("tenant", "workspace", "1", storage.mountRoot(), WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
            try (var provisioner = new SshRuntimeProvisioner(id -> node, ignored -> storage, connections,
                    new HttpRuntimeTransport(connections::resolveEndpoint))) {
                request = provisioner.createRequest(scope, "harness");
                var binding = bindings.findOrCreate(request);
                var claim = bindings.claimOperation(binding.getBindingId(), "setup", Duration.ofSeconds(30));
                var seed = claim.getProvisionSeed();
                var handle = await(provisioner.ensureResource(request, seed, null));
                saved = bindings.compareAndSet(claim, claim.withResourceHandle(handle, java.time.Instant.now()));
                bindings.releaseOperation(saved.getBindingId(), "setup", saved.getOperationGeneration());
                launch = request("ensure", Map.of("resourceId", handle.getValue().get("resourceId"),
                        "bindingId", saved.getBindingId(), "bindingGeneration", saved.getGeneration(),
                        "boot", ManagedContextProtocol.boot(request, seed), "identity", storage.registration().get("identity"),
                        "marker", storage.registration().get("marker"), "expectedQwenVersion", storage.registration().get("qwenVersion"),
                        "workerEntry", node.qwenEntry(), "launch", true));
            }
        }
        for (int attempt = 0; attempt < 100; attempt++) {
            try (var files = Files.list(controlDirectory)) {
                if (files.noneMatch(SshRuntimeInteropTest::controlSocket)) {
                    break;
                }
            }
            Thread.sleep(25);
        }
        Map<String, Object> fixture = Map.of("node", Map.of("nodeId", node.nodeId(), "displayName", node.displayName(),
                        "sshHost", node.sshHost(), "nodeExecutable", node.nodeExecutable(), "qwenEntry", node.qwenEntry(),
                        "stateDirectory", node.stateDirectory(), "allowedRoots", node.allowedRoots(), "publicationPort", node.publicationPort()),
                "publicationEndpoint", publicationEndpoint().toString(), "controlDirectory", controlDirectory.toString(),
                "sshConfig", sshConfig.toString(), "request", launch);
        Process child = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp", System.getProperty("java.class.path"), CrashLauncher.class.getName())
                .redirectError(root.resolve("crashed-broker.log").toFile()).start();
        crashedBroker = child;
        try (var input = child.getOutputStream()) {
            input.write(JsonCodec.encode(fixture));
        }
        assertTrue(child.waitFor(30, TimeUnit.SECONDS), "Crash fixture did not halt");
        assertEquals(0, child.exitValue(), Files.readString(root.resolve("crashed-broker.log")));
        var launched = JsonCodec.parseObject(child.getInputStream().readAllBytes(), "crashed broker result");
        long pid = ((Number) launched.get("pid")).longValue();
        workerPids.add(pid);
        assertTrue(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
        masterStarts.set(0);
        try (var connections = connections()) {
            var http = new HttpRuntimeTransport(connections::resolveEndpoint);
            var transport = new WorkspaceTransport(http, bindings, sessions, executions);
            try (var provisioner = new SshRuntimeProvisioner(id -> node, ignored -> storage, connections, http);
                    var service = new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(request.getScope()),
                            provisioner, transport, bindings, sessions, executions, "restored-broker",
                            Duration.ofSeconds(30), Duration.ofSeconds(30))) {
                await(service.acquire("harness", "runtime-restored", "continuation"));
                var restored = bindings.findById(saved.getBindingId());
                assertEquals(saved.getResourceHandle(), restored.getResourceHandle());
                assertEquals(0, masterStarts.get(), "Restart must adopt the old master instead of conflicting on its reverse port");
                var observed = connections.bootstrap(node, request("observe", Map.of("resourceId", launch.get("resourceId"))));
                assertEquals(pid, ((Number) observed.get("pid")).longValue());
                assertEquals("success", runFile(service, "runtime-restored", "after-crash").getExecutionStatus());
                String fetch = "const response=await fetch('" + connections.publicationEndpoint(node)
                        + "/probe');process.stdout.write(await response.text());";
                assertEquals("reverse-publication-ok", command(List.of("ssh", "-F", sshConfig.toString(), node.sshHost(),
                        quote(node.nodeExecutable()) + " --input-type=module -e " + quote(fetch))));
                service.requestHarnessDrain("tenant", "harness");
                await(service.drainHarnessSession("tenant", "harness"));
                assertTrue(bindings.findById(saved.getBindingId()).getDrainReceipt().matches(restored));
                assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
            }
        }
    }

    @Test
    void aKilledOriginalWorkerIsNeverRelaunchedAndCannotProduceACleanReceipt() throws Exception {
        try (var connections = connections()) {
            var storage = registerStorage(connections);
            var scope = new RuntimeScope("tenant", "workspace", "1", storage.mountRoot(), WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
            var http = new HttpRuntimeTransport(connections::resolveEndpoint);
            try (var provisioner = new SshRuntimeProvisioner(id -> node, ignored -> storage, connections, http)) {
                var request = provisioner.createRequest(scope, "harness");
                var repository = new InMemoryRuntimeBindingRepository();
                var binding = repository.findOrCreate(request);
                var claim = repository.claimOperation(binding.getBindingId(), "owner", Duration.ofSeconds(30));
                var seed = claim.getProvisionSeed();
                var handle = await(provisioner.ensureResource(request, seed, null));
                var lease = await(provisioner.provision(request, seed));
                String resourceId = (String) handle.getValue().get("resourceId");
                var observed = connections.bootstrap(node, request("observe", Map.of("resourceId", resourceId)));
                long pid = ((Number) observed.get("pid")).longValue();
                workerPids.add(pid);
                var process = ProcessHandle.of(pid).orElseThrow();
                process.destroyForcibly();
                process.onExit().get(5, TimeUnit.SECONDS);
                var ready = claim.withAttestation(lease, handle, java.time.Instant.now(), java.time.Instant.now());
                var draining = ready.withDrainRequested(true, java.time.Instant.now())
                        .withState(RuntimeBindingRecord.State.DRAINING, lease, java.time.Instant.now());
                assertThrows(ExecutionException.class, () -> await(provisioner.reconcile(request, seed, handle, lease)));
                assertThrows(ExecutionException.class, () -> await(provisioner.provision(request, seed)));
                assertThrows(ExecutionException.class, () -> await(provisioner.stopDrained(draining)));
                assertEquals(pid, ((Number) connections.bootstrap(node, request("observe", Map.of("resourceId", resourceId))).get("pid")).longValue());
                assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
            }
        }
    }

    @Test
    void aNeverLaunchedIntentCanBeSealedAndRetiredWithoutCreatingAWorker() throws Exception {
        try (var connections = connections()) {
            var storage = registerStorage(connections);
            var scope = new RuntimeScope("tenant", "workspace", "1", storage.mountRoot(), WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
            var http = new HttpRuntimeTransport(connections::resolveEndpoint);
            try (var provisioner = new SshRuntimeProvisioner(id -> node, ignored -> storage, connections, http)) {
                var request = provisioner.createRequest(scope, "harness");
                var repository = new InMemoryRuntimeBindingRepository();
                var binding = repository.findOrCreate(request);
                var claim = repository.claimOperation(binding.getBindingId(), "owner", Duration.ofSeconds(30));
                var handle = await(provisioner.ensureResource(request, claim.getProvisionSeed(), null));
                var draining = claim.withResourceHandle(handle, java.time.Instant.now()).withDrainRequested(true, java.time.Instant.now());
                var receipt = await(provisioner.stopDrained(draining));
                assertTrue(receipt.matches(draining));
                assertThrows(ExecutionException.class, () -> await(provisioner.provision(request, claim.getProvisionSeed())));
                var observed = connections.bootstrap(node, request("observe", Map.of("resourceId", handle.getValue().get("resourceId"))));
                assertEquals("RETIRED", observed.get("state"));
                assertEquals(null, observed.get("pid"));
            }
        }
    }

    @Test
    void noStartShellAcknowledgementRetiresTheOriginalWorkerAfterADroppedReply() throws Exception {
        noStartShellAcknowledgement(false);
    }

    @Test
    void deferredNoStartShellAcknowledgementRetiresTheOriginalWorkerAfterADroppedReply() throws Exception {
        noStartShellAcknowledgement(true);
    }

    private void noStartShellAcknowledgement(boolean deferred) throws Exception {
        try (var connections = connections()) {
            var storage = registerStorage(connections);
            var scope = new RuntimeScope("tenant", "workspace", "1", storage.mountRoot(), WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
            var http = new HttpRuntimeTransport(connections::resolveEndpoint);
            var bindings = new InMemoryRuntimeBindingRepository();
            var sessions = new InMemoryRuntimeSessionRepository();
            var executions = new InMemoryToolExecutionRepository();
            var transport = new WorkspaceTransport(http, bindings, sessions, executions);
            try (var provisioner = new SshRuntimeProvisioner(id -> node, ignored -> storage, connections, http);
                    var service = new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(scope), provisioner,
                            transport, bindings, sessions, executions, "broker", Duration.ofSeconds(30), Duration.ofSeconds(30))) {
                var session = await(service.acquire("harness", "runtime", "bootstrap"));
                var binding = bindings.findById(session.getBindingId());
                Map<String, Object> input = new LinkedHashMap<>();
                input.put("command", "printf should-not-run");
                input.put("directory", root.resolve("outside").toString());
                String digest = CsiNativeActivationProof.sha256(JsonCodec.encode(input));
                Map<String, Object> wire = Map.of("sessionId", "runtime", "promptId", "prompt-no-start",
                        "callId", "call-no-start", "argsDigest", deferred ? "sha256:" + digest : digest);
                Map<String, Object> reference = new LinkedHashMap<>(wire);
                if (deferred) {
                    reference.put("dispatchMode", "deferred_v3");
                    reference.put("publicationId", "publication-1");
                    reference.put("payloadDigest", "payload-digest");
                } else {
                    reference.put("runtimeProtocol", 3);
                    reference.put("inputDigest", digest);
                    reference.put("argsDigest", "payload-digest");
                }
                var prepared = executions.findOrCreate(ToolExecutionRecord.prepared("shell-no-start", "shell-no-start-key",
                        binding.getBindingId(), binding.getGeneration(), "harness", "runtime", "prompt-no-start", "call-no-start",
                        "payload-digest", reference));
                var claim = executions.claimDispatch(prepared.getExecutionCallId(), "dispatcher", Duration.ofMinutes(1));
                if (deferred) {
                    var fixtures = JsonCodec.parseObject(Files.readAllBytes(Path.of("").toAbsolutePath()
                            .resolve("../core/src/managed-runtime/contracts/managed-tool-publication-v1.fixtures.json").normalize()), "publication fixture");
                    Map<String, Object> publication = ((List<?>) fixtures.get("cases")).stream()
                            .map(ProviderRuntimeProtocol::object).filter(item -> "distinct-model-runtime-ids".equals(item.get("id")))
                            .map(item -> new LinkedHashMap<>(ProviderRuntimeProtocol.object(item.get("value")))).findFirst().orElseThrow();
                    publication.putAll(Map.of("sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", "harness"),
                            "turnId", "prompt-no-start", "executionCallId", prepared.getExecutionCallId(),
                            "runtimeBindingId", binding.getBindingId(), "reference", wire, "bindingGeneration", Long.toString(binding.getGeneration())));
                    await(http.installPublication(binding.getLease(), session.getSession(), new RuntimePublicationGrant("publication-1",
                            "A".repeat(43), "http://127.0.0.1:" + node.publicationPort() + "/", publication)));
                } else {
                    await(http.installPublisherV3(binding.getLease(), session.getSession(), Map.of("url", "http://127.0.0.1:"
                            + node.publicationPort() + "/internal/hosted-shell-publisher/v1", "token", "A".repeat(43))));
                }
                Map<String, Object> capture = Map.of("tenantId", "tenant", "sessionId", "harness", "turnId", "prompt-no-start",
                        "executionCallId", prepared.getExecutionCallId(), "bindingGeneration", Long.toString(binding.getGeneration()),
                        "capturePolicy", "complete_required");
                Map<String, Object> answer = await(http.executeV3(binding.getLease(), session.getSession(), wire,
                        Map.of("toolName", "run_shell_command", "input", input), capture));
                for (int attempt = 0; !"settled".equals(answer.get("state")) && attempt < 100; attempt++) {
                    Thread.sleep(50);
                    answer = await(http.statusV3(binding.getLease(), session.getSession(), wire, 0));
                }
                assertEquals("settled", answer.get("state"));
                Map<String, Object> result = ProviderRuntimeProtocol.object(answer.get("result"));
                assertEquals("not_started", result.get("executionStatus"));
                assertTrue(result.containsKey("capture"));
                assertEquals(null, result.get("capture"));
                var settled = executions.compareAndSet(claim, claim.withResult(result, 1, java.time.Instant.now()),
                        "dispatcher", claim.getDispatchGeneration());
                assertTrue(settled.isSettled());
                String resourceId = (String) binding.getResourceHandle().getValue().get("resourceId");
                long pid = ((Number) connections.bootstrap(node, request("observe", Map.of("resourceId", resourceId))).get("pid")).longValue();
                workerPids.add(pid);
                await(service.release("harness", "runtime"));
                service.requestHarnessDrain("tenant", "harness");
                assertThrows(ExecutionException.class, () -> await(service.drainHarnessSession("tenant", "harness")));
                assertTrue(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
                assertEquals(0, sessions.countActiveByBinding(binding.getBindingId(), binding.getGeneration()));
                service.close();
                try (var restoredConnections = connections()) {
                    var restoredHttp = new HttpRuntimeTransport(restoredConnections::resolveEndpoint);
                    var restoredTransport = new WorkspaceTransport(restoredHttp, bindings, sessions, executions);
                    restoredTransport.loseFirstAcknowledgement = false;
                    try (var restoredProvisioner = new SshRuntimeProvisioner(id -> node, ignored -> storage, restoredConnections, restoredHttp);
                            var restoredService = new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(scope), restoredProvisioner,
                                    restoredTransport, bindings, sessions, executions, "restored", Duration.ofSeconds(30), Duration.ofSeconds(30))) {
                        await(restoredService.drainHarnessSession("tenant", "harness"));
                        assertEquals(1, restoredTransport.acknowledgements.get());
                        assertEquals(0, restoredTransport.executions.get());
                    }
                }
                assertTrue(bindings.findById(binding.getBindingId()).getDrainReceipt().matches(binding));
                assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
                assertEquals(1, transport.acknowledgements.get());
                assertEquals(0, transport.executions.get(), "No-start ACK retry must not dispatch again");
            }
        }
    }

    @Test
    void rebuildsTheMissingSqlStopReceiptFromTheOriginalCleanProofWithoutHttpAcknowledgement() throws Exception {
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        SshRuntimeStorage storage;
        RuntimeScope scope;
        RuntimeBindingRecord binding;
        RuntimeDrainReceipt originalProof;
        long pid;
        try (var connections = connections()) {
            storage = registerStorage(connections);
            scope = new RuntimeScope("tenant", "workspace", "1", storage.mountRoot(), WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
            var http = new HttpRuntimeTransport(connections::resolveEndpoint);
            var transport = new WorkspaceTransport(http, bindings, sessions, executions);
            try (var provisioner = new SshRuntimeProvisioner(id -> node, ignored -> storage, connections, http);
                    var service = new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(scope), provisioner,
                            transport, bindings, sessions, executions, "broker", Duration.ofSeconds(30), Duration.ofSeconds(30))) {
                var session = await(service.acquire("harness", "runtime", "bootstrap"));
                binding = bindings.findById(session.getBindingId());
                String resourceId = (String) binding.getResourceHandle().getValue().get("resourceId");
                pid = ((Number) connections.bootstrap(node, request("observe", Map.of("resourceId", resourceId))).get("pid")).longValue();
                workerPids.add(pid);
                var execution = runFile(service, "runtime", "read-before-retirement");
                await(http.acknowledgeV2(binding.getLease(), session.getSession(), execution.getReference()));
                await(service.release("harness", "runtime"));
                service.requestHarnessDrain("tenant", "harness");
                var retiring = bindings.claimOperation(binding.getBindingId(), "lost-receipt", Duration.ofSeconds(30));
                binding = bindings.compareAndSet(retiring, retiring.withDrainRequested(true, java.time.Instant.now())
                        .withState(RuntimeBindingRecord.State.DRAINING, retiring.getLease(), java.time.Instant.now()));
                originalProof = await(provisioner.stopDrained(binding));
                assertTrue(originalProof.matches(binding));
                assertEquals(null, bindings.findById(binding.getBindingId()).getDrainReceipt(), "Simulate Broker loss before SQL receipt commit");
                assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
                bindings.releaseOperation(binding.getBindingId(), "lost-receipt", binding.getOperationGeneration());
            }
        }
        try (var restoredConnections = connections()) {
            var http = new HttpRuntimeTransport(restoredConnections::resolveEndpoint);
            var transport = new WorkspaceTransport(http, bindings, sessions, executions);
            try (var provisioner = new SshRuntimeProvisioner(id -> node, ignored -> storage, restoredConnections, http);
                    var service = new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(scope), provisioner,
                            transport, bindings, sessions, executions, "restored", Duration.ofSeconds(30), Duration.ofSeconds(30))) {
                await(service.drainHarnessSession("tenant", "harness"));
                var retired = bindings.findById(binding.getBindingId());
                assertEquals(RuntimeBindingRecord.State.RELEASED, retired.getState());
                assertEquals(originalProof, retired.getDrainReceipt());
                assertEquals(0, transport.acknowledgements.get(), "A verified clean proof cannot require HTTP on the exited worker");
                assertEquals(0, transport.executions.get());
                assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
            }
        }
    }

    @Test
    void reusesOneWorkerAcrossTurnsReconnectsSshAndRetriesOnlyDurableAcknowledgements() throws Exception {
        try (var connections = connections()) {
            var storage = registerStorage(connections);
            String fetch = "const response = await fetch('" + connections.publicationEndpoint(node)
                    + "/probe'); process.stdout.write(await response.text());";
            assertEquals("reverse-publication-ok", command(List.of("ssh", "-F", sshConfig.toString(), node.sshHost(),
                    quote(node.nodeExecutable()) + " --input-type=module -e " + quote(fetch))));
            var scope = new RuntimeScope("tenant", "workspace", "1", storage.mountRoot(), WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
            var http = new HttpRuntimeTransport(connections::resolveEndpoint);
            var bindings = new InMemoryRuntimeBindingRepository();
            var sessions = new InMemoryRuntimeSessionRepository();
            var executions = new InMemoryToolExecutionRepository();
            var transport = new WorkspaceTransport(http, bindings, sessions, executions);
            try (var provisioner = new SshRuntimeProvisioner(id -> node, ignored -> storage, connections, http);
                    var service = new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(scope), provisioner,
                            transport, bindings, sessions, executions, "broker", Duration.ofSeconds(30), Duration.ofSeconds(30))) {
                await(service.acquire("harness", "runtime-one", "bootstrap"));
                var binding = service.findLatestBindingByHarnessSessionAnyState("tenant", "harness");
                String resourceId = (String) binding.getResourceHandle().getValue().get("resourceId");
                Map<String, Object> original = connections.bootstrap(node, request("observe", Map.of("resourceId", resourceId)));
                long pid = ((Number) original.get("pid")).longValue();
                workerPids.add(pid);
                assertEquals("success", runFile(service, "runtime-one", "read-one").getExecutionStatus());
                await(service.release("harness", "runtime-one"));
                String masterStatus = command(List.of("ssh", "-F", sshConfig.toString(), "-S", controlSocket.get().toString(),
                        "-O", "check", node.sshHost()));
                var masterPid = java.util.regex.Pattern.compile("pid=([1-9][0-9]*)").matcher(masterStatus);
                assertTrue(masterPid.find(), masterStatus);
                var master = ProcessHandle.of(Long.parseLong(masterPid.group(1))).orElseThrow();
                master.destroyForcibly();
                master.onExit().get(5, TimeUnit.SECONDS);
                assertTrue(Files.exists(controlSocket.get()), "SIGKILL should leave the owned Unix socket stale");
                await(service.acquire("harness", "runtime-two", "continuation"));
                assertEquals(binding.getLease().getEndpoint(), service.findLatestBindingByHarnessSessionAnyState("tenant", "harness").getLease().getEndpoint());
                assertEquals(pid, ((Number) connections.bootstrap(node, request("observe", Map.of("resourceId", resourceId))).get("pid")).longValue());
                assertEquals("success", runFile(service, "runtime-two", "read-two").getExecutionStatus());
                service.requestHarnessDrain("tenant", "harness");
                await(service.drainHarnessSession("tenant", "harness"));
                var retired = bindings.findById(binding.getBindingId());
                assertEquals(RuntimeBindingRecord.State.RELEASED, retired.getState());
                assertNotNull(retired.getDrainReceipt());
                assertTrue(retired.getDrainReceipt().matches(retired));
                assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
                assertEquals(2, transport.executions.get(), "ACK retry must never dispatch the file tool again");
                assertTrue(transport.acknowledgements.get() >= 3, "close resends ACKs from durable settled inventory");
            }
        }
    }

    private SshRuntimeStorage registerStorage(SshConnectionManager connections) {
        Map<String, Object> probe = connections.bootstrap(node, request("probe", Map.of("root", root.resolve("workspace").toString(),
                "allowedRoots", node.allowedRoots())));
        Map<String, Object> identity = ProviderRuntimeProtocol.object(probe.get("identity"));
        var marker = new LinkedHashMap<>(identity);
        marker.putAll(Map.of("version", 2, "tenantId", "tenant", "storageId", "storage:ssh", "registrationId", UUID.randomUUID().toString()));
        connections.bootstrap(node, request("register-storage", Map.of("identity", identity, "marker", marker)));
        return new SshRuntimeStorage(node.nodeId(), "storage:ssh", (String) identity.get("root"),
                Map.of("identity", identity, "marker", marker, "qwenVersion", probe.get("qwenVersion")));
    }

    private SshConnectionManager connections() {
        return new SshConnectionManager(publicationEndpoint(), controlDirectory,
                (arguments, input, timeout) -> {
                    var actual = new ArrayList<>(arguments);
                    actual.addAll(1, List.of("-F", sshConfig.toString()));
                    if (arguments.contains("-N")) {
                        masterStarts.incrementAndGet();
                        controlSocket.set(Path.of(arguments.get(arguments.indexOf("-S") + 1)));
                    }
                    return SshConnectionManager.runCommand(actual, input, timeout);
                });
    }

    private URI publicationEndpoint() {
        return URI.create("http://127.0.0.1:" + publications.getAddress().getPort() + "/publications");
    }

    private ToolExecutionRecord runFile(RuntimeBrokerService service, String runtime, String call) throws Exception {
        Map<String, Object> input = Map.of("file_path", "original.txt");
        String digest = "sha256:" + CsiNativeActivationProof.sha256(JsonCodec.encode(input));
        var execution = await(service.createExecution("harness", runtime, call, Map.of("sessionId", runtime,
                "promptId", "turn-" + call, "callId", call, "argsDigest", digest, "toolName", "read_file", "input", input)));
        for (int attempt = 0; !execution.isTerminal() && attempt < 100; attempt++) {
            Thread.sleep(50);
            execution = await(service.getExecution("harness", runtime, execution.getExecutionCallId()));
        }
        assertTrue(execution.isSettled());
        return execution;
    }

    private Map<String, Object> request(String operation, Map<String, Object> fields) {
        var request = new LinkedHashMap<>(fields);
        request.putAll(Map.of("protocolVersion", 1, "operation", operation, "nodeId", node.nodeId(),
                "stateDirectory", node.stateDirectory()));
        return request;
    }

    private static int port() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static String command(List<String> arguments) throws Exception {
        Process process = new ProcessBuilder(arguments).redirectErrorStream(true).start();
        assertTrue(process.waitFor(10, TimeUnit.SECONDS), "Test command timed out");
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(0, process.exitValue(), output);
        return output;
    }

    private static String quote(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }

    private static boolean controlSocket(Path path) {
        return path.getFileName().toString().matches("n[0-9a-f]{16}");
    }

    public static final class CrashLauncher {
        public static void main(String[] arguments) throws Exception {
            var fixture = JsonCodec.parseObject(System.in.readAllBytes(), "crash fixture");
            var config = ProviderRuntimeProtocol.object(fixture.get("node"));
            var node = new SshRuntimeNode((String) config.get("nodeId"), (String) config.get("displayName"),
                    (String) config.get("sshHost"), (String) config.get("nodeExecutable"), (String) config.get("qwenEntry"),
                    (String) config.get("stateDirectory"), ((List<?>) config.get("allowedRoots")).stream().map(String.class::cast).toList(),
                    ((Number) config.get("publicationPort")).intValue());
            var manager = new SshConnectionManager(URI.create((String) fixture.get("publicationEndpoint")),
                    Path.of((String) fixture.get("controlDirectory")), (command, input, timeout) -> {
                        var actual = new ArrayList<>(command);
                        actual.addAll(1, List.of("-F", (String) fixture.get("sshConfig")));
                        return SshConnectionManager.runCommand(actual, input, timeout);
                    });
            var request = ProviderRuntimeProtocol.object(fixture.get("request"));
            var result = manager.bootstrap(node, request);
            long deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos();
            while ("STARTING".equals(result.get("state")) && System.nanoTime() < deadline) {
                Thread.sleep(100);
                result = manager.bootstrap(node, Map.of("protocolVersion", 1, "operation", "observe", "nodeId", node.nodeId(),
                        "stateDirectory", node.stateDirectory(), "resourceId", request.get("resourceId")));
            }
            assertEquals("READY", result.get("state"));
            var boot = ProviderRuntimeProtocol.object(request.get("boot"));
            var ready = ProviderRuntimeProtocol.object(result.get("ready"));
            var scope = new RuntimeScope((String) boot.get("tenantId"), (String) boot.get("workspaceId"),
                    (String) boot.get("workspaceGeneration"), (String) boot.get("mountRoot"),
                    (String) boot.get("capabilityDigest"), (String) boot.get("isolationClass"));
            var seed = new RuntimeProvisionSeed((String) boot.get("provisionRequestId"), (String) boot.get("runtimeInstanceId"),
                    (String) boot.get("runtimeIncarnation"), (String) boot.get("leaseId"), ((Number) boot.get("epoch")).longValue(), (String) boot.get("token"));
            var placement = new RuntimeProvisionRequest(scope, "harness", SshRuntimeProvisioner.KIND, (String) boot.get("storageId"));
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), ManagedContextProtocol.ready(ready, boot),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            manager.register(lease, node);
            await(new HttpRuntimeTransport(manager::resolveEndpoint).attest(lease, placement, seed));
            System.out.write(JsonCodec.encode(result));
            System.out.flush();
            Runtime.getRuntime().halt(0);
        }
    }

    private static <T> T await(CompletionStage<T> stage) throws Exception {
        return stage.toCompletableFuture().get(60, TimeUnit.SECONDS);
    }

    private static final class WorkspaceTransport implements RuntimeTransport {
        private final HttpRuntimeTransport http;
        private final InMemoryRuntimeBindingRepository bindings;
        private final InMemoryRuntimeSessionRepository sessions;
        private final InMemoryToolExecutionRepository records;
        private final AtomicInteger executions = new AtomicInteger();
        private final AtomicInteger acknowledgements = new AtomicInteger();
        private boolean loseFirstAcknowledgement = true;

        private WorkspaceTransport(HttpRuntimeTransport http, InMemoryRuntimeBindingRepository bindings,
                InMemoryRuntimeSessionRepository sessions, InMemoryToolExecutionRepository records) {
            this.http = http;
            this.bindings = bindings;
            this.sessions = sessions;
            this.records = records;
        }

        @Override
        public CompletionStage<RuntimeAttestation> attest(RuntimeLease lease, RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
            return http.attest(lease, request, seed);
        }

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) {
            var runtime = bindings.findByHarnessSession("tenant", "harness", null, 100).getFirst();
            var record = sessions.findById(session.getScope(), session.getRuntimeSessionId());
            var context = context(session);
            return http.installContext(runtime, record, UUID.randomUUID().toString(), context)
                    .thenCompose(ignored -> http.activateWorkspace(runtime, record, context, true));
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
            var runtime = bindings.findByHarnessSession("tenant", "harness", null, 100).getFirst();
            return http.activateWorkspace(runtime, sessions.findById(session.getScope(), session.getRuntimeSessionId()),
                    context(session), false).thenApply(ignored -> true);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease, RuntimeSession session, Map<String, Object> reference) {
            executions.incrementAndGet();
            return http.execute(lease, session, reference);
        }

        @Override
        public CompletionStage<Void> acknowledgeV2(RuntimeLease lease, RuntimeSession session, Map<String, Object> reference) {
            var persisted = records.findByIdempotencyKey((String) reference.get("callId"));
            assertTrue(persisted != null && persisted.isSettled(), "ACK preceded SQL result settlement");
            if (acknowledgements.incrementAndGet() == 1 && loseFirstAcknowledgement) {
                return CompletableFuture.failedFuture(new IOException("Simulated lost ACK before delivery"));
            }
            return http.acknowledgeV2(lease, session, reference);
        }

        @Override
        public CompletionStage<Map<String, Object>> acknowledge(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference, Map<String, Object> receipt) {
            Map<String, Object> wire = new LinkedHashMap<>();
            for (String field : List.of("sessionId", "promptId", "callId")) {
                wire.put(field, reference.get(field));
            }
            wire.put("argsDigest", reference.get("inputDigest"));
            return acknowledgeV3(lease, session, wire, receipt);
        }

        @Override
        public CompletionStage<Map<String, Object>> acknowledgeV3(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference, Map<String, Object> receipt) {
            var persisted = records.findByExecutionCallId((String) receipt.get("executionCallId"));
            assertTrue(persisted != null && persisted.isSettled(), "ACK preceded durable result settlement");
            if (acknowledgements.incrementAndGet() == 1 && loseFirstAcknowledgement) {
                return CompletableFuture.failedFuture(new IOException("Simulated lost no-start ACK before delivery"));
            }
            return http.acknowledgeV3(lease, session, reference, receipt);
        }

        @Override
        public CompletionStage<Map<String, Object>> status(RuntimeLease lease, RuntimeSession session, Map<String, Object> reference, long after) {
            return http.status(lease, session, reference, after);
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease, RuntimeSession session, Map<String, Object> reference) {
            return http.cancel(lease, session, reference);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.failedFuture(new AssertionError("No provider controls expected"));
        }

        private static ContextBinding context(RuntimeSession session) {
            return new ContextBinding("tenant", "workspace", 1, "storage:ssh", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        }
    }
}
