package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

@DisabledOnOs(OS.WINDOWS)
class SshConnectionManagerTest {
    @TempDir
    Path controlDirectory;
    private static final SshRuntimeNode NODE = new SshRuntimeNode("linux", "Linux", "worker-linux", "/opt/node",
            "/opt/qwen's cli/cli.js", "/var/tmp/qwen", List.of("/workspace"), 34561);

    @Test
    void admitsOneControllerAndRejectsConfigurationDriftBeforeTouchingSsh() {
        Path shared = controlDirectory.resolve("stable");
        URI endpoint = URI.create("http://127.0.0.1:8080");
        SshConnectionManager.CommandRunner runner = (command, input, timeout) -> input.length == 0 ? success()
                : new SshConnectionManager.CommandResult(0,
                        JsonCodec.encode(Map.of("protocolVersion", 1, "ok", true, "result", Map.of())));
        try (var first = new SshConnectionManager(endpoint, shared, runner)) {
            first.bootstrap(NODE, Map.of("operation", "probe"));
            var busy = assertThrows(RuntimeBrokerException.class, () -> new SshConnectionManager(endpoint, shared, runner));
            assertEquals("ssh_runtime_controller_busy", busy.getCode());
        }
        var calls = new AtomicInteger();
        for (var changed : List.of(
                new SshRuntimeNode(NODE.nodeId(), NODE.displayName(), "another-host", NODE.nodeExecutable(),
                        NODE.qwenEntry(), NODE.stateDirectory(), NODE.allowedRoots(), NODE.publicationPort()),
                new SshRuntimeNode(NODE.nodeId(), NODE.displayName(), NODE.sshHost(), NODE.nodeExecutable(),
                        NODE.qwenEntry(), "/another-state-directory", NODE.allowedRoots(), NODE.publicationPort()))) {
            try (var restarted = new SshConnectionManager(endpoint, shared, (command, input, timeout) -> {
                calls.incrementAndGet();
                return success();
            })) {
                assertThrows(RuntimeBrokerException.class, () -> restarted.bootstrap(changed, Map.of("operation", "probe")));
                assertEquals(0, calls.get(), "Configuration drift must not touch an unknown master");
            }
        }
    }

    @Test
    void closeRetainsControllerOwnershipUntilTheInFlightBootstrapFinishes() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        Path shared = controlDirectory.resolve("closing");
        URI endpoint = URI.create("http://127.0.0.1:8080");
        SshConnectionManager.CommandRunner runner = (command, input, timeout) -> {
            if (input.length == 0) {
                return success();
            }
            entered.countDown();
            try {
                if (!release.await(3, TimeUnit.SECONDS)) {
                    throw new AssertionError("Bootstrap was not released");
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new AssertionError(error);
            }
            return new SshConnectionManager.CommandResult(0,
                    JsonCodec.encode(Map.of("protocolVersion", 1, "ok", true, "result", Map.of())));
        };
        try (var manager = new SshConnectionManager(endpoint, shared, runner);
                var executor = Executors.newFixedThreadPool(2)) {
            var bootstrap = executor.submit(() -> manager.bootstrap(NODE, Map.of("operation", "probe")));
            assertTrue(entered.await(1, TimeUnit.SECONDS));
            var closing = executor.submit(manager::close);
            try {
                assertThrows(TimeoutException.class, () -> closing.get(100, TimeUnit.MILLISECONDS));
                var busy = assertThrows(RuntimeBrokerException.class,
                        () -> new SshConnectionManager(endpoint, shared, runner));
                assertEquals("ssh_runtime_controller_busy", busy.getCode());
            } finally {
                release.countDown();
            }
            bootstrap.get(1, TimeUnit.SECONDS);
            closing.get(1, TimeUnit.SECONDS);
        }
        try (var restarted = new SshConnectionManager(endpoint, shared, runner)) {
            assertEquals(Map.of(), restarted.bootstrap(NODE, Map.of("operation", "probe")));
        }
    }

    @Test
    void aDetachedControlProcessCannotKeepAJavaStdoutPipeOpen() {
        var result = SshConnectionManager.runCommand(List.of("/bin/sh", "-c", "sleep 2 &"),
                new byte[0], Duration.ofSeconds(5));
        assertEquals(0, result.exitCode());
        assertEquals(0, result.stdout().length);
    }

    @Test
    void keepsCredentialsInStdinAndQuotesOnlyTrustedRemoteEntryPaths() {
        var commands = new ArrayList<List<String>>();
        var payload = new AtomicReference<byte[]>();
        try (var manager = manager(URI.create("http://127.0.0.1:8080/tool-publications"),
                (command, input, timeout) -> {
                    commands.add(command);
                    if (input.length == 0) {
                        return success();
                    }
                    payload.set(input);
                    return new SshConnectionManager.CommandResult(0,
                            JsonCodec.encode(Map.of("protocolVersion", 1, "ok", true, "result", Map.of("platform", "linux"))));
                })) {
            var request = Map.<String, Object>of("protocolVersion", 1, "operation", "probe", "nodeId", NODE.nodeId(),
                    "stateDirectory", NODE.stateDirectory(), "token", "secret-credential");
            assertEquals("linux", manager.bootstrap(NODE, request).get("platform"));
            assertEquals("secret-credential", JsonCodec.parseObject(payload.get(), "payload").get("token"));
            var ssh = commands.getLast();
            assertTrue(ssh.contains("StrictHostKeyChecking=yes"));
            assertTrue(ssh.contains("BatchMode=yes"));
            assertTrue(ssh.contains("ForwardAgent=no"));
            assertFalse(String.join(" ", ssh).contains("secret-credential"));
            assertEquals("'/opt/node' '/opt/qwen'\\''s cli/cli.js' managed-runtime-bootstrap", ssh.getLast());
            assertTrue(commands.getFirst().contains("127.0.0.1:34561:127.0.0.1:8080"));
            assertEquals(URI.create("http://127.0.0.1:34561/tool-publications"), manager.publicationEndpoint(NODE));
        }
        assertTrue(commands.getLast().contains("exit"));
        assertFalse(commands.getLast().contains("stop"), "Broker close only closes its own SSH connection");
    }

    @Test
    void reconnectsTunnelsWithoutChangingLeaseIdentityOrLaunchingAWorker() {
        var commands = new ArrayList<List<String>>();
        var broken = new AtomicBoolean();
        var remote = URI.create("http://127.0.0.1:41234/");
        var lease = new RuntimeLease("runtime", remote, "token", "lease", 1);
        try (var manager = manager(URI.create("http://127.0.0.1:8080"),
                (command, input, timeout) -> {
                    commands.add(command);
                    return command.contains("check") && broken.getAndSet(false)
                            ? new SshConnectionManager.CommandResult(255, new byte[0]) : success();
                })) {
            manager.register(lease, NODE);
            URI first = manager.resolveEndpoint(lease);
            assertEquals("127.0.0.1", first.getHost());
            assertEquals(first, manager.resolveEndpoint(lease));
            assertEquals(1, commands.stream().filter(command -> command.contains("forward")).count());
            broken.set(true);
            manager.resolveEndpoint(lease);
            assertEquals(2, commands.stream().filter(command -> command.contains("forward")).count());
            assertEquals(2, commands.stream().filter(command -> command.contains("-N")).count());
            assertEquals(remote, lease.getEndpoint());
            assertTrue(commands.stream().noneMatch(command -> command.stream()
                    .anyMatch(argument -> argument.contains("managed-runtime-bootstrap"))));
        }
    }

    @Test
    void routesTwoNodesWithTheSameRemotePortIndependently() {
        var commands = new ArrayList<List<String>>();
        var second = new SshRuntimeNode("mac", "Mac", "worker-mac", "/opt/node", "/opt/qwen.js",
                "/var/tmp/qwen", List.of("/workspace"), 34562);
        try (var manager = manager(URI.create("http://127.0.0.1:8080"),
                (command, input, timeout) -> {
                    commands.add(command);
                    return success();
                })) {
            var firstLease = new RuntimeLease("runtime-a", URI.create("http://127.0.0.1:41234"), "a", "a", 1);
            var secondLease = new RuntimeLease("runtime-b", URI.create("http://127.0.0.1:41234"), "b", "b", 1);
            manager.register(firstLease, NODE);
            manager.register(secondLease, second);
            manager.resolveEndpoint(firstLease);
            manager.resolveEndpoint(secondLease);
            assertEquals(List.of("worker-linux", "worker-mac"), commands.stream()
                    .filter(command -> command.contains("forward")).map(List::getLast).toList());
            assertThrows(RuntimeBrokerException.class, () -> manager.register(firstLease, second));
        }
    }

    @Test
    void refusesEveryUnknownLeaseAndDirectsOnlyExplicitlyRegisteredLocalLeases() {
        var lease = new RuntimeLease("unknown", URI.create("http://127.0.0.1:41234"), "token", "lease", 1);
        try (var manager = manager(URI.create("http://127.0.0.1:8080"),
                (command, input, timeout) -> { throw new AssertionError("No SSH command expected"); })) {
            assertThrows(RuntimeBrokerException.class, () -> manager.resolveEndpoint(lease));
            manager.registerDirect(lease);
            assertEquals(lease.getEndpoint(), manager.resolveEndpoint(lease));
            assertThrows(RuntimeBrokerException.class, () -> manager.register(lease, NODE));
        }
    }

    @Test
    void anUnresponsiveNodeDoesNotHoldTheConnectionLockForAnotherNode() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var second = new SshRuntimeNode("mac", "Mac", "worker-mac", "/opt/node", "/opt/qwen.js",
                "/var/tmp/qwen", List.of("/workspace"), 34562);
        try (var manager = manager(URI.create("http://127.0.0.1:8080"),
                (command, input, timeout) -> {
                    if (command.contains("-N") && command.contains(NODE.sshHost())) {
                        entered.countDown();
                        try {
                            if (!release.await(3, TimeUnit.SECONDS)) {
                                throw new AssertionError("Second node was blocked behind first node");
                            }
                        } catch (InterruptedException error) {
                            Thread.currentThread().interrupt();
                            throw new AssertionError(error);
                        }
                    }
                    return input.length == 0 ? success() : new SshConnectionManager.CommandResult(0,
                            JsonCodec.encode(Map.of("protocolVersion", 1, "ok", true, "result", Map.of())));
                }); var executor = Executors.newFixedThreadPool(2)) {
            var slow = executor.submit(() -> manager.bootstrap(NODE, Map.of("operation", "probe")));
            assertTrue(entered.await(1, TimeUnit.SECONDS));
            try {
                executor.submit(() -> manager.bootstrap(second, Map.of("operation", "probe"))).get(1, TimeUnit.SECONDS);
            } finally {
                release.countDown();
            }
            slow.get(1, TimeUnit.SECONDS);
        }
    }

    @Test
    void boundsBootstrapOutputAndPreservesOnlyKnownSanitizedErrors() {
        for (byte[] output : List.of(new byte[65537], "not json".getBytes(java.nio.charset.StandardCharsets.UTF_8),
                JsonCodec.encode(Map.of("protocolVersion", 2, "ok", true, "result", Map.of())))) {
            try (var manager = manager(URI.create("http://127.0.0.1:8080"),
                    (command, input, timeout) -> input.length == 0 ? success()
                            : new SshConnectionManager.CommandResult(0, output))) {
                assertThrows(RuntimeBrokerException.class, () -> manager.bootstrap(NODE, Map.of("operation", "probe")));
            }
        }
        try (var manager = manager(URI.create("http://127.0.0.1:8080"),
                (command, input, timeout) -> input.length == 0 ? success()
                        : new SshConnectionManager.CommandResult(0, JsonCodec.encode(Map.of("protocolVersion", 1, "ok", false,
                                "error", Map.of("code", "ssh_runtime_directory_conflict", "message", "secret", "retryable", false)))))) {
            RuntimeBrokerException failure = assertThrows(RuntimeBrokerException.class,
                    () -> manager.bootstrap(NODE, Map.of("operation", "probe")));
            assertEquals("ssh_runtime_directory_conflict", failure.getCode());
            assertFalse(failure.isRetryable());
            assertFalse(failure.getMessage().contains("secret"));
        }
    }

    private static SshConnectionManager.CommandResult success() {
        return new SshConnectionManager.CommandResult(0, new byte[0]);
    }

    private SshConnectionManager manager(URI endpoint, SshConnectionManager.CommandRunner runner) {
        return new SshConnectionManager(endpoint, controlDirectory.resolve(java.util.UUID.randomUUID().toString()), runner);
    }
}
