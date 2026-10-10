package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.FakeKubernetesRuntimeClient.map;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;

/** Opt-in protocol integration: fake scheduler observations, real Broker and bundled worker. */
@EnabledIfSystemProperty(named = "qwen.kubernetes.worker-test", matches = "true")
class KubernetesRuntimeWorkerTest {
    @TempDir
    Path directory;
    private Process worker;

    @Test
    void runsFileToolsAndAdoptsTheOriginalWorkerWithoutReplayingItsWrites() throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../../dist/cli.js")).toAbsolutePath().normalize();
        assertTrue(Files.isRegularFile(cli), "Build and bundle the CLI before running this integration test");
        Path workspace = Files.createDirectory(directory.resolve("workspace")).toRealPath();
        Path bootFile = directory.resolve("boot.json");
        Path stdout = directory.resolve("worker.stdout");
        Path stderr = directory.resolve("worker.stderr");
        var api = new FakeKubernetesRuntimeClient();
        api.podIp = localAddress();
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var transport = new HttpRuntimeTransport();
        List<String> command = List.of("node", cli.toString());
        api.podCreated = pod -> {
            try {
                String encoded = (String) map(api.object("secrets").get("data")).get("boot.json");
                Files.write(bootFile, Base64.getDecoder().decode(encoded));
                List<?> declared = (List<?>) map(((List<?>) map(pod.get("spec")).get("containers")).getFirst()).get("command");
                List<String> launch = new ArrayList<>();
                declared.forEach(value -> launch.add((String) value));
                launch.set(launch.size() - 1, bootFile.toString());
                var builder = new ProcessBuilder(launch).directory(workspace.toFile())
                        .redirectOutput(stdout.toFile()).redirectError(stderr.toFile());
                builder.environment().put("HOME", directory.toString());
                builder.environment().put("QWEN_RUNTIME_DIR", directory.resolve("runtime").toString());
                worker = builder.start();
                worker.getOutputStream().close();
                awaitReady(stdout);
            } catch (Exception error) {
                throw new IllegalStateException("Real container worker could not start", error);
            }
        };
        RuntimeScope scope = new RuntimeScope("tenant", "workspace", "1", workspace.toString(),
                "sha256:" + "a".repeat(64), "session");
        var first = new KubernetesRuntimeProvisioner(api, "test-cluster", "runtimes",
                KubernetesRuntimeProvisionerTest.IMAGE, command);
        var restored = new KubernetesRuntimeProvisioner(api, "test-cluster", "runtimes",
                KubernetesRuntimeProvisionerTest.IMAGE, command);
        try (first; restored;
                var broker = broker(first, scope, transport, bindings, sessions, executions, "first")) {
            var session = join(broker.acquire("harness", "runtime-session", "bootstrap"));
            var binding = bindings.findById(session.getBindingId());
            Path file = workspace.resolve("result.txt");
            var write = reference("write", "write_file", Map.of("file_path", file.toString(), "content", "alpha\n"));
            var written = settle(broker, join(broker.createExecution("harness", "runtime-session", "write-key", write)));
            assertEquals(ToolExecutionRecord.State.SETTLED, written.getState());
            assertEquals("success", written.getExecutionStatus());
            assertEquals("alpha\n", Files.readString(file));

            var edit = reference("edit", "edit", Map.of("file_path", file.toString(),
                    "old_string", "alpha", "new_string", "beta"));
            var edited = settle(broker, join(broker.createExecution("harness", "runtime-session", "edit-key", edit)));
            assertEquals("success", edited.getExecutionStatus());
            assertEquals("beta\n", Files.readString(file));
            var duplicate = join(broker.createExecution("harness", "runtime-session", "write-key", write));
            assertEquals(written.getExecutionCallId(), duplicate.getExecutionCallId());
            assertEquals("beta\n", Files.readString(file), "Retry must not overwrite the later edit");

            var read = reference("read", "read_file", Map.of("file_path", file.toString()));
            var readResult = settle(broker, join(broker.createExecution("harness", "runtime-session", "read-key", read)));
            assertEquals("success", readResult.getExecutionStatus());
            assertTrue(readResult.getResult().toString().contains("beta"));
            var original = join(transport.status(binding.getLease(), session.getSession(), write, 0));
            assertEquals("settled", original.get("state"));
            join(transport.execute(binding.getLease(), session.getSession(), write));
            assertEquals("beta\n", Files.readString(file), "Worker journal must also deduplicate the original call");

            first.close();
            try (var replacement = broker(restored, scope, transport, bindings, sessions, executions, "replacement")) {
                var adopted = join(replacement.warm("harness"));
                assertEquals(binding.getResourceHandle(), adopted.getResourceHandle());
                assertEquals(binding.getGeneration(), adopted.getGeneration());
                assertEquals(binding.getLease().getEndpoint(), adopted.getLease().getEndpoint());
                join(restored.confirm(adopted.getRequest(), adopted.getLease()));
                assertEquals(written.getResult(), join(replacement.getExecution("harness", "runtime-session",
                        written.getExecutionCallId())).getResult());
                join(transport.execute(adopted.getLease(), session.getSession(), write));
                assertEquals("beta\n", Files.readString(file));
                map(api.object("pods").get("metadata")).put("uid", "replacement-pod");
                assertEquals(RuntimeObservation.Outcome.CONFLICT, join(restored.reconcile(adopted.getRequest(),
                        adopted.getProvisionSeed(), adopted.getResourceHandle(), adopted.getLease())).getOutcome());
                assertThrows(CompletionException.class,
                        () -> restored.confirm(adopted.getRequest(), adopted.getLease()).toCompletableFuture().join());
            }
            assertEquals(2, api.creates);
            assertTrue(worker.isAlive(), "Closing Brokers must not retire the shared physical Runtime");
            String boot = Files.readString(bootFile);
            String token = (String) JsonCodec.parseObject(boot.getBytes(java.nio.charset.StandardCharsets.UTF_8), "boot").get("token");
            assertFalse(Files.readString(stdout).contains(token));
            assertFalse(Files.readString(stderr).contains(token));
        } finally {
            if (worker != null) {
                worker.destroy();
                if (!worker.waitFor(10, TimeUnit.SECONDS)) {
                    worker.destroyForcibly();
                    assertTrue(worker.waitFor(5, TimeUnit.SECONDS));
                }
            }
        }
    }

    private static RuntimeBrokerService broker(KubernetesRuntimeProvisioner provisioner, RuntimeScope scope,
            HttpRuntimeTransport transport, InMemoryRuntimeBindingRepository bindings,
            InMemoryRuntimeSessionRepository sessions, InMemoryToolExecutionRepository executions, String owner) {
        return new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(scope), provisioner, transport,
                bindings, sessions, executions, owner, Duration.ofSeconds(30), Duration.ofSeconds(30));
    }

    private static Map<String, Object> reference(String call, String tool, Map<String, Object> input) {
        return Map.of("sessionId", "runtime-session", "promptId", "turn", "callId", call,
                "argsDigest", "digest-" + call, "toolName", tool, "input", input);
    }

    private void awaitReady(Path stdout) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(20).toNanos();
        while (System.nanoTime() < deadline && worker.isAlive()) {
            String output = Files.readString(stdout);
            if (output.contains("\n")) {
                assertEquals("ready", JsonCodec.parseObject(output.strip().getBytes(java.nio.charset.StandardCharsets.UTF_8), "ready").get("type"));
                return;
            }
            Thread.sleep(25);
        }
        throw new IllegalStateException("Worker did not emit its ready record");
    }

    private static String localAddress() throws Exception {
        return NetworkInterface.networkInterfaces().filter(network -> {
            try {
                return network.isUp() && !network.isLoopback() && !network.isPointToPoint();
            } catch (java.net.SocketException error) {
                return false;
            }
        }).flatMap(NetworkInterface::inetAddresses)
                .filter(address -> address instanceof Inet4Address && address.isSiteLocalAddress())
                .map(java.net.InetAddress::getHostAddress).findFirst()
                .orElseThrow(() -> new IllegalStateException("Integration test requires a reachable local IPv4 address"));
    }

    private static <T> T join(CompletionStage<T> result) throws Exception {
        return result.toCompletableFuture().get(40, TimeUnit.SECONDS);
    }

    private static ToolExecutionRecord settle(RuntimeBrokerService broker, ToolExecutionRecord record) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
        while (!record.isSettled() && System.nanoTime() < deadline) {
            Thread.sleep(25);
            record = join(broker.getExecution("harness", "runtime-session", record.getExecutionCallId()));
        }
        assertTrue(record.isSettled(), "Execution must reach a terminal state");
        return record;
    }
}
