package com.alibaba.qwen.code.managedagent.preflight;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.sun.net.httpserver.HttpServer;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.mock.env.MockEnvironment;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ManagedAgentPreflightTest {
    private static final String DIGEST = "sha256:" + "a".repeat(64);

    @Test
    void treatsOnlyLoopbackSpellingsAsLoopback() {
        assertTrue(ManagedAgentPreflight.isLoopback("127.0.0.1"));
        assertTrue(ManagedAgentPreflight.isLoopback("::1"));
        assertTrue(ManagedAgentPreflight.isLoopback("localhost"));
        assertTrue(ManagedAgentPreflight.isLoopback(null));
        assertFalse(ManagedAgentPreflight.isLoopback("0.0.0.0"));
        assertFalse(ManagedAgentPreflight.isLoopback("10.0.0.1"));
    }

    @Test
    void acceptsOnlyLowercaseSha256Digests() {
        assertTrue(ManagedAgentPreflight.isDigest(DIGEST));
        assertFalse(ManagedAgentPreflight.isDigest(
                "sha256:" + "A".repeat(64)));
        assertFalse(ManagedAgentPreflight.isDigest("sha256:abc"));
    }

    @Test
    void requiresA32ByteCredentialKey() {
        assertTrue(ManagedAgentPreflight.isCredentialKey(encoded(32)));
        assertFalse(ManagedAgentPreflight.isCredentialKey(encoded(31)));
        assertFalse(ManagedAgentPreflight.isCredentialKey("not-base64"));
    }

    @Test
    void reportsDurableCapacityStatesWithoutClaimingPhysicalResources()
            throws Exception {
        try (Connection connection = DriverManager.getConnection(
                "jdbc:h2:mem:preflight-capacity;DB_CLOSE_DELAY=-1")) {
            try (var statement = connection.createStatement()) {
                statement.execute("CREATE TABLE ma_runtime_binding "
                        + "(binding_state VARCHAR(32))");
                statement.execute("CREATE TABLE ma_runtime_session "
                        + "(session_state VARCHAR(32))");
                statement.execute("CREATE TABLE ma_operation "
                        + "(state VARCHAR(32))");
                statement.execute("INSERT INTO ma_runtime_binding VALUES "
                        + "('READY'), ('READY'), ('DRAINING')");
                statement.execute("INSERT INTO ma_runtime_session VALUES "
                        + "('READY'), ('RELEASED')");
                statement.execute("INSERT INTO ma_operation VALUES "
                        + "('PENDING'), ('COMPLETED')");
            }

            ManagedAgentPreflight.Check check =
                    ManagedAgentPreflight.capacityCheck(connection);

            assertEquals(ManagedAgentPreflight.Status.PASS, check.status());
            assertTrue(check.detail().contains("READY=2"));
            assertTrue(check.detail().contains("PENDING=1"));
            assertTrue(check.detail().contains("physical-processes=unknown"));
            assertTrue(check.detail().contains("memory=unknown"));
            assertTrue(check.detail().contains(
                    "idle-reclamation=not measured"));
        }
    }

    @Test
    void readsTheConfigLocationFromArgumentsBeforeTheEnvironment() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("SPRING_CONFIG_ADDITIONAL_LOCATION",
                "file:/from-env.yml");
        List<String> locations = ManagedAgentPreflight.configLocations(
                new String[] {"--spring.config.additional-location="
                        + "file:/from-arg.yml"}, environment);
        assertEquals(List.of("file:/from-arg.yml"), locations);
    }

    @Test
    void fallsBackToTheEnvironmentConfigLocation() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("SPRING_CONFIG_ADDITIONAL_LOCATION",
                "file:/from-env.yml,optional:file:/optional.yml");
        List<String> locations = ManagedAgentPreflight.configLocations(
                new String[0], environment);
        assertEquals(
                List.of("file:/from-env.yml", "optional:file:/optional.yml"),
                locations);
    }

    @Test
    void rejectsAutoModeOnANonLoopbackBind() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "0.0.0.0");
        ManagedAgentPreflight.Check check = ManagedAgentPreflight.authCheck(
                environment, new ManagedAgentProperties());
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
    }

    @Test
    void requiresASigningKeyForSignedMode() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "0.0.0.0");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("signed");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment, properties)
                        .status());
    }

    @Test
    void probesTheHarnessCapabilitiesEndpoint() throws IOException {
        HttpServer server = capabilitiesServer(capabilities(DIGEST, ""));
        try {
            String url = "http://127.0.0.1:" + server.getAddress().getPort();
            ManagedAgentPreflight.Check check =
                    ManagedAgentPreflight.harnessCheck(harness(url), "0.26.0");
            assertEquals(ManagedAgentPreflight.Status.PASS, check.status());
            assertEquals(url + "/capabilities compatible: Hosted Harness"
                    + " protocol 1, capability digest matches, Qwen Code 0.26.0",
                    check.detail());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void negotiatesWithTheHarnessAsTheFirstSessionDoes() throws IOException {
        String other = "sha256:" + "b".repeat(64);
        HttpServer mismatched = capabilitiesServer(capabilities(other, ""));
        try {
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.harnessCheck(
                    harness("http://127.0.0.1:" + mismatched.getAddress().getPort()), null);
            assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
            assertTrue(check.detail().endsWith(
                    "advertises another capability digest"), check.detail());
            // Without the credentials file, each side has its own variable.
            assertEquals("give the Harness's QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST"
                    + " and the control plane's QWEN_MANAGED_AGENT_CAPABILITY_DIGEST"
                    + " the same value", check.fix());
            assertFalse(check.detail().contains(other), "the digest stays out");
        } finally {
            mismatched.stop(0);
        }
        HttpServer old = capabilitiesServer(capabilities(DIGEST, "")
                .replace("\"managed_session_journal_delta_v1\",", ""));
        try {
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.harnessCheck(
                    harness("http://127.0.0.1:" + old.getAddress().getPort()),
                    "0.26.0");
            assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
            assertTrue(check.detail().endsWith("is not a compatible Hosted Harness:"
                    + " Endpoint does not advertise managed_session_journal_delta_v1"),
                    check.detail());
            assertEquals("install Qwen Code 0.26.0", check.fix());
            // Without a manifest the fix names no version.
            assertEquals("install the Qwen Code version the distribution manifest names",
                    ManagedAgentPreflight.harnessCheck(harness("http://127.0.0.1:"
                            + old.getAddress().getPort()), null).fix());
        } finally {
            old.stop(0);
        }
    }

    @Test
    void tellsAFailedCompatibilityRequestFromAnIncompatibleHarness() throws IOException {
        // The probe is answered; the negotiation's own request is not.
        for (int second : new int[] {-1, 503}) {
            HttpServer server = sequenceServer(second);
            try {
                ManagedAgentPreflight.Check check = ManagedAgentPreflight.harnessCheck(
                        harness("http://127.0.0.1:" + server.getAddress().getPort()),
                        "0.26.0");
                assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
                assertFalse(check.detail().contains("is not a compatible Hosted Harness"),
                        check.detail());
                assertEquals("check that the Harness is reachable, then run --check again",
                        check.fix());
                assertTrue(check.detail().contains(second < 0
                        ? "did not answer the compatibility request"
                        : "answered the compatibility request with HTTP 503"), check.detail());
                // The response body is the Harness's text and stays out.
                assertFalse(check.detail().contains("forged"), check.detail());
            } finally {
                server.stop(0);
            }
        }
        HttpServer server = capabilitiesServer(capabilities(DIGEST, ""));
        try {
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.harnessCheck(harness(
                    "http://user:secret@127.0.0.1:" + server.getAddress().getPort()), null);
            assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
            assertFalse(check.detail().contains("secret"), check.detail());
            assertFalse(check.detail().contains("user:"), check.detail());
            assertTrue(check.fix().startsWith("set QWEN_MANAGED_AGENT_HARNESS_BASE_URL"),
                    check.fix());
        } finally {
            server.stop(0);
        }
        // A row that answers 503 names the URL it dialled.
        HttpServer failing = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        failing.createContext("/capabilities", exchange -> {
            exchange.sendResponseHeaders(503, -1);
            exchange.close();
        });
        failing.start();
        try {
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.harnessCheck(harness(
                    "http://127.0.0.1:" + failing.getAddress().getPort()), null);
            assertEquals("http://127.0.0.1:" + failing.getAddress().getPort()
                    + "/capabilities answered 503", check.detail());
        } finally {
            failing.stop(0);
        }
    }

    // Answers the first /capabilities request, then drops (-1) or answers
    // the next with that status and a body full of control characters.
    private static HttpServer sequenceServer(int second) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        byte[] envelope = capabilities(DIGEST, "")
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] hostile = "upstream reset\n\u001b[2JPASS harness forged"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        AtomicInteger requests = new AtomicInteger();
        server.createContext("/capabilities", exchange -> {
            if (requests.incrementAndGet() == 1) {
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, envelope.length);
                exchange.getResponseBody().write(envelope);
            } else if (second > 0) {
                exchange.sendResponseHeaders(second, hostile.length);
                exchange.getResponseBody().write(hostile);
            }
            exchange.close();
        });
        server.start();
        return server;
    }

    @Test
    void comparesTheHarnessVersionWithTheManifest() throws IOException {
        HttpServer server = capabilitiesServer(capabilities(DIGEST, ""));
        try {
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.harnessCheck(
                    harness("http://127.0.0.1:" + server.getAddress().getPort()),
                    "0.27.0");
            assertEquals(ManagedAgentPreflight.Status.WARN, check.status());
            assertTrue(check.detail().endsWith("Qwen Code 0.26.0, but this"
                    + " distribution was built for 0.27.0"), check.detail());
            assertEquals("install Qwen Code 0.27.0", check.fix());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void warnsWhenTheHarnessDoesNotAdvertiseAReadableVersion() throws IOException {
        HttpServer silent = capabilitiesServer(capabilities(DIGEST, "")
                .replace("\"qwenCodeVersion\":\"0.26.0\",", ""));
        HttpServer hostile = capabilitiesServer(capabilities(DIGEST, "")
                .replace("\"0.26.0\"", "\"0.26.0\\nPASS harness forged\""));
        try {
            for (HttpServer server : List.of(silent, hostile)) {
                String url = "http://127.0.0.1:" + server.getAddress().getPort();
                ManagedAgentPreflight.Check check =
                        ManagedAgentPreflight.harnessCheck(harness(url), "0.26.0");
                assertEquals(ManagedAgentPreflight.Status.WARN, check.status());
                assertEquals(url + "/capabilities compatible: Hosted Harness protocol 1,"
                        + " capability digest matches, but it does not advertise a"
                        + " readable Qwen Code version, so it was not compared with 0.26.0",
                        check.detail());
                assertEquals("install Qwen Code 0.26.0", check.fix());
                // Without a manifest there is nothing to compare.
                ManagedAgentPreflight.Check unknown =
                        ManagedAgentPreflight.harnessCheck(harness(url), null);
                assertEquals(ManagedAgentPreflight.Status.PASS, unknown.status());
                assertEquals(url + "/capabilities compatible: Hosted Harness protocol 1,"
                        + " capability digest matches", unknown.detail());
            }
        } finally {
            silent.stop(0);
            hostile.stop(0);
        }
    }

    @Test
    void comparesTheHarnessVersionWithTheManifestBesideLib(@TempDir Path directory)
            throws IOException {
        Path lib = Files.createDirectories(directory.resolve("lib"));
        Path jar = Files.writeString(lib.resolve("server.jar"), "");
        Files.writeString(directory.resolve("manifest.json"),
                "{\"compatibility\":{\"qwenCodeVersion\":\"0.27.0\"}}");
        HttpServer server = capabilitiesServer(capabilities(DIGEST, ""));
        String classPath = System.getProperty("java.class.path");
        try {
            // The row reads the manifest the distribution ships beside lib/.
            System.setProperty("java.class.path", jar.toString());
            ManagedAgentPreflight.Check harness = ManagedAgentPreflight.checks(
                    new String[] {
                        "--qwen.managed-agent.harness.enabled=true",
                        "--qwen.managed-agent.harness.base-url=http://127.0.0.1:"
                                + server.getAddress().getPort(),
                        "--qwen.managed-agent.harness.token=" + "e".repeat(64),
                        "--qwen.managed-agent.harness.capability-digest=" + DIGEST,
                        "--qwen.managed-agent.runtime-broker.enabled=false",
                        "--server.port=0",
                        "--spring.datasource.url=",
                    }).stream().filter(check -> check.name().equals("harness"))
                    .findFirst().orElseThrow();
            assertEquals(ManagedAgentPreflight.Status.WARN, harness.status(),
                    harness.detail());
            assertTrue(harness.detail().endsWith(
                    "this distribution was built for 0.27.0"), harness.detail());
            assertEquals("install Qwen Code 0.27.0", harness.fix());
        } finally {
            System.setProperty("java.class.path", classPath);
            server.stop(0);
        }
    }

    @Test
    void readsTheVersionFromTheProbeAndTheProtocolFromTheNegotiation()
            throws IOException {
        // The probe meets one instance behind the origin, the negotiation
        // another: the row must not describe both as if they were one.
        String probe = capabilities(DIGEST, "")
                .replace("\"qwenCodeVersion\":\"0.26.0\"",
                        "\"qwenCodeVersion\":\"0.27.0\"");
        HttpServer server = capabilitiesServer(List.of(probe, capabilities(DIGEST, "")));
        try {
            String url = "http://127.0.0.1:" + server.getAddress().getPort();
            ManagedAgentPreflight.Check check =
                    ManagedAgentPreflight.harnessCheck(harness(url), "0.27.0");
            assertEquals(ManagedAgentPreflight.Status.PASS, check.status(),
                    check.detail());
            assertEquals(url + "/capabilities compatible: Hosted Harness protocol 1,"
                    + " capability digest matches, Qwen Code 0.27.0", check.detail());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void requiresTheLifecycleTheWorkspaceToolsNeed() throws IOException {
        HttpServer textOnly = capabilitiesServer(capabilities(DIGEST, "")
                .replace("\"lifecycleProtocolVersion\":1,", ""));
        HttpServer filesOnly = capabilitiesServer(capabilities(DIGEST, ""));
        try {
            ManagedAgentProperties files = harness(
                    "http://127.0.0.1:" + textOnly.getAddress().getPort());
            files.getHarness().setWorkspaceFilesEnabled(true);
            ManagedAgentPreflight.Check noFiles =
                    ManagedAgentPreflight.harnessCheck(files, null);
            assertEquals(ManagedAgentPreflight.Status.FAIL, noFiles.status());
            assertTrue(noFiles.detail().endsWith("does not support Workspace files"));
            ManagedAgentProperties shell = harness(
                    "http://127.0.0.1:" + filesOnly.getAddress().getPort());
            shell.getHarness().setWorkspaceFilesEnabled(true);
            shell.getHarness().setWorkspaceShellEnabled(true);
            ManagedAgentPreflight.Check noShell =
                    ManagedAgentPreflight.harnessCheck(shell, null);
            assertEquals(ManagedAgentPreflight.Status.FAIL, noShell.status());
            assertEquals("add hosted-workspace-shell/1 to QWEN_HOSTED_LIFECYCLE_V2_PROFILES"
                    + " in the Harness environment; an explicit value replaces the whole"
                    + " list, so set it to hosted-workspace-shell/1", noShell.fix());
            // Profiles an AgentDefinition may select need their lifecycle too.
            ManagedAgentProperties mcp = harness(
                    "http://127.0.0.1:" + filesOnly.getAddress().getPort());
            mcp.getHarness().setWorkspaceFilesEnabled(true);
            mcp.setDefinitionToolProfiles(List.of("hosted-workspace-files/1",
                    "hosted-workspace-files/3", "hosted-workspace-mcp/1"));
            ManagedAgentPreflight.Check noMcp = ManagedAgentPreflight.harnessCheck(mcp, null);
            assertEquals(ManagedAgentPreflight.Status.FAIL, noMcp.status());
            assertTrue(noMcp.detail().endsWith("does not offer hosted-workspace-mcp/1"),
                    noMcp.detail());
        } finally {
            textOnly.stop(0);
            filesOnly.stop(0);
        }
        // The fix keeps what the Harness already offers: the variable
        // replaces the whole list.
        HttpServer mcpOnly = capabilitiesServer(
                capabilities(DIGEST, "\"hosted-workspace-mcp/1\""));
        try {
            ManagedAgentProperties shell = harness(
                    "http://127.0.0.1:" + mcpOnly.getAddress().getPort());
            shell.getHarness().setWorkspaceFilesEnabled(true);
            shell.getHarness().setWorkspaceShellEnabled(true);
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.harnessCheck(shell, null);
            assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
            assertTrue(check.fix().endsWith("so set it to"
                    + " hosted-workspace-mcp/1,hosted-workspace-shell/1"), check.fix());
        } finally {
            mcpOnly.stop(0);
        }
        HttpServer withShell = capabilitiesServer(
                capabilities(DIGEST, "\"hosted-workspace-shell/1\""));
        HttpServer withShellMcp = capabilitiesServer(
                capabilities(DIGEST, "\"hosted-workspace-shell/1\"").replace(
                        "\"lifecycleProtocolVersion\":1,",
                        "\"features\":[\"workspace-shell-mcp/1\"],\"lifecycleProtocolVersion\":1,"));
        try {
            ManagedAgentProperties shell = harness(
                    "http://127.0.0.1:" + withShell.getAddress().getPort());
            shell.getHarness().setWorkspaceFilesEnabled(true);
            shell.getHarness().setWorkspaceShellEnabled(true);
            // Shell Sessions that pin MCP servers need workspace-shell-mcp/1.
            // The version matches, so the fix names the missing capability.
            ManagedAgentPreflight.Check noShellMcp =
                    ManagedAgentPreflight.harnessCheck(shell, "0.26.0");
            assertEquals(ManagedAgentPreflight.Status.WARN, noShellMcp.status());
            assertTrue(noShellMcp.detail().endsWith("but it does not offer"
                    + " workspace-shell-mcp/1, so Shell Sessions whose agent pins MCP"
                    + " servers fail"), noShellMcp.detail());
            assertFalse(noShellMcp.fix().startsWith("install Qwen Code"),
                    noShellMcp.fix());
            assertTrue(noShellMcp.fix().startsWith("upgrade the Harness to a build"
                    + " that offers workspace-shell-mcp/1"), noShellMcp.fix());
            shell.getHarness().setBaseUrl(
                    "http://127.0.0.1:" + withShellMcp.getAddress().getPort());
            ManagedAgentPreflight.Check shellMcp = ManagedAgentPreflight.harnessCheck(shell, null);
            assertEquals(ManagedAgentPreflight.Status.PASS, shellMcp.status(),
                    shellMcp.detail());
        } finally {
            withShell.stop(0);
            withShellMcp.stop(0);
        }
    }

    @Test
    void readsTheQwenCodeVersionFromTheManifestBesideLib(@TempDir Path directory)
            throws IOException {
        Path lib = Files.createDirectories(directory.resolve("lib"));
        Path jar = Files.writeString(lib.resolve("server.jar"), "");
        // Two levels below the root, so the first entry resolves nothing.
        Path elsewhere = Files.createDirectories(directory.resolve("elsewhere/deep"));
        Path other = Files.writeString(elsewhere.resolve("other.jar"), "");
        Path manifest = Files.writeString(directory.resolve("manifest.json"),
                "{\"compatibility\":{\"qwenCodeVersion\":\"0.26.0\"}}");
        // The manifest the database row reads, found from any classpath
        // entry: the first one resolves to nothing.
        assertEquals(manifest, ManagedAgentPreflight.findManifest(
                other + java.io.File.pathSeparator + jar));
        assertEquals("0.26.0", ManagedAgentPreflight.manifestQwenCodeVersion(manifest));
        Files.writeString(manifest, "{\"compatibility\":{}}");
        assertNull(ManagedAgentPreflight.manifestQwenCodeVersion(manifest));
        Files.delete(manifest);
        assertNull(ManagedAgentPreflight.manifestQwenCodeVersion(manifest));
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledOnOs(org.junit.jupiter.api.condition.OS.LINUX)
    void reportsAWorkerStartedFromTheConfiguredExecutable(@TempDir Path directory)
            throws Exception {
        Path state = Files.createDirectory(directory.resolve("state"));
        ManagedAgentProperties properties = workerProperties(state);
        // A copy, because /proc/<pid>/exe resolves a symlink back to its target.
        Path runtime = Files.copy(Path.of("/bin/sh"), directory.resolve("qwen-runtime"),
                java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        runtime.toFile().setExecutable(true);
        properties.getRuntimeBroker().setNodeExecutable(runtime.toString());
        Process worker = worker(runtime, state);
        try {
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.workersCheck(
                    properties, () -> List.of(worker.toHandle()), false);
            assertEquals(ManagedAgentPreflight.Status.WARN, check.status(),
                    check.detail());
            assertEquals("1 Runtime worker(s) of an earlier run are alive (pid "
                    + worker.pid() + ")", check.detail());
        } finally {
            reap(worker);
        }
        // The same binary reached through a symlink: /proc names the target,
        // so the configured path has to be resolved before it is compared.
        Path link = Files.createSymbolicLink(directory.resolve("current"), runtime);
        properties.getRuntimeBroker().setNodeExecutable(link.toString());
        Process throughLink = worker(link, state);
        try {
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.workersCheck(
                    properties, () -> List.of(throughLink.toHandle()), false);
            assertEquals(ManagedAgentPreflight.Status.WARN, check.status(),
                    check.detail());
            assertEquals("1 Runtime worker(s) of an earlier run are alive (pid "
                    + throughLink.pid() + ")", check.detail());
        } finally {
            reap(throughLink);
        }
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledOnOs(org.junit.jupiter.api.condition.OS.LINUX)
    void reportsRuntimeWorkersLeftFromAnEarlierRun(@TempDir Path directory)
            throws Exception {
        Path state = Files.createDirectory(directory.resolve("state"));
        Path elsewhere = Files.createDirectory(directory.resolve("elsewhere"));
        ManagedAgentProperties properties = workerProperties(state);
        properties.getRuntimeBroker().setDurableLocalProcess(false);
        Path node = node(directory);
        // Workers run `node <entry> managed-runtime-worker` in the state directory.
        Process worker = worker(node, state);
        Process other = worker(node, elsewhere);
        Process notWorker = new ProcessBuilder(node.toString(), "-c", "sleep 60 & wait")
                .directory(state.toFile()).start();
        // The marker without the entry before it, or from another program,
        // is not a worker.
        Process imitation = new ProcessBuilder(node.toString(), "-c", "sleep 60 & wait",
                "-f", "managed-runtime-worker").directory(state.toFile()).start();
        Process diagnostic = new ProcessBuilder("tail", "-f", "/dev/null",
                "managed-runtime-worker").directory(state.toFile()).start();
        try {
            ProcessHandle.Info info = worker.toHandle().info();
            assertTrue(ManagedAgentPreflight.isWorkerCommand(info.command().orElseThrow(),
                    info.arguments().orElseThrow(), null), "the fixture keeps its argv");
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.workersCheck(
                    properties, () -> List.of(worker.toHandle(), other.toHandle(),
                            notWorker.toHandle(), imitation.toHandle(),
                            diagnostic.toHandle()), false);
            assertEquals(ManagedAgentPreflight.Status.WARN, check.status());
            assertEquals("1 Runtime worker(s) of an earlier run are alive (pid "
                    + worker.pid() + ")", check.detail());
            assertTrue(check.fix().startsWith("stop them before starting the server:"
                    + " systemctl kill --kill-whom=all"), check.fix());
            // A durable Broker adopts them, so the fix does not ask for a kill.
            properties.getRuntimeBroker().setDurableLocalProcess(true);
            ManagedAgentPreflight.Check durable = ManagedAgentPreflight.workersCheck(
                    properties, () -> List.of(worker.toHandle()), false);
            assertEquals(ManagedAgentPreflight.Status.WARN, durable.status());
            assertTrue(durable.fix().startsWith("a durable Broker adopts them"),
                    durable.fix());
            // Online, a durable Broker's adopted workers look like leftovers.
            ManagedAgentPreflight.Check adopted = ManagedAgentPreflight.workersCheck(
                    properties, () -> List.of(worker.toHandle()), true);
            assertEquals(ManagedAgentPreflight.Status.SKIP, adopted.status());
            assertTrue(adopted.detail().startsWith("online: the running durable Broker"),
                    adopted.detail());
            // Online, a worker that still has its parent belongs to the server.
            properties.getRuntimeBroker().setDurableLocalProcess(false);
            ManagedAgentPreflight.Check owned = ManagedAgentPreflight.workersCheck(
                    properties, () -> List.of(worker.toHandle()), true);
            assertEquals(ManagedAgentPreflight.Status.PASS, owned.status());
            assertEquals("online: no Runtime worker outlived an earlier run",
                    owned.detail());
            // The preflight process never counts itself.
            assertEquals(ManagedAgentPreflight.WorkerMatch.MATCH,
                    ManagedAgentPreflight.workerMatch(worker.toHandle(),
                            state.toRealPath(), ProcessHandle.current().pid(), null));
            assertEquals(ManagedAgentPreflight.WorkerMatch.OTHER,
                    ManagedAgentPreflight.workerMatch(worker.toHandle(),
                            state.toRealPath(), worker.pid(), null));
        } finally {
            for (Process process : List.of(worker, other, notWorker, imitation, diagnostic)) {
                reap(process);
            }
        }
        assertEquals(ManagedAgentPreflight.Status.PASS, ManagedAgentPreflight
                .workersCheck(properties, () -> List.of(worker.toHandle()), false).status());
        properties.getRuntimeBroker().setProvisioner("static");
        ManagedAgentPreflight.Check noRuntime = ManagedAgentPreflight
                .workersCheck(properties, List::of, false);
        assertEquals(ManagedAgentPreflight.Status.SKIP, noRuntime.status());
        assertEquals("no local-process Runtime configured", noRuntime.detail());
        properties.getRuntimeBroker().setProvisioner("local-process");
        properties.getRuntimeBroker().setEnabled(false);
        // Online reports the same reason when no worker can exist.
        ManagedAgentPreflight.Check disabled = ManagedAgentPreflight
                .workersCheck(properties, List::of, true);
        assertEquals(ManagedAgentPreflight.Status.SKIP, disabled.status());
        assertEquals("no local-process Runtime configured", disabled.detail());
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledOnOs(org.junit.jupiter.api.condition.OS.LINUX)
    void warnsWhenAWorkerCannotBeInspected(@TempDir Path directory)
            throws IOException {
        Path state = Files.createDirectory(directory.resolve("state"));
        ManagedAgentProperties properties = workerProperties(state);
        // Another uid's worker reads as this: its argv is world-readable,
        // /proc/<pid>/exe and cwd are not. Its pid is not one this run has.
        long foreign = ProcessHandle.current().pid() + 100_000L;
        ProcessHandle unreadable = handle(foreign, Optional.empty(),
                Optional.of(new String[] {"/opt/qwen-code/dist/cli.js",
                        "managed-runtime-worker"}));
        ManagedAgentPreflight.Check check = ManagedAgentPreflight.workersCheck(
                properties, () -> List.of(unreadable), false);
        assertEquals(ManagedAgentPreflight.Status.WARN, check.status());
        assertEquals("1 process(s) matching the Runtime worker command line"
                + " could not be inspected, so leftover workers were not ruled out",
                check.detail());
        assertEquals("run --check as root or as the service account", check.fix());
        // An ordinary process without the argv stays out of the count.
        ProcessHandle other = handle(foreign, Optional.empty(),
                Optional.of(new String[] {"-f", "/dev/null"}));
        assertEquals(ManagedAgentPreflight.Status.PASS, ManagedAgentPreflight
                .workersCheck(properties, () -> List.of(other), false).status());
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledOnOs(org.junit.jupiter.api.condition.OS.LINUX)
    void reportsBothLeftoversAndUninspectedWorkers(@TempDir Path directory)
            throws Exception {
        Path state = Files.createDirectory(directory.resolve("state"));
        ManagedAgentProperties properties = workerProperties(state);
        Process worker = worker(node(directory), state);
        ProcessHandle unreadable = handle(ProcessHandle.current().pid() + 100_000L,
                Optional.empty(), Optional.of(new String[] {
                        "/opt/qwen-code/dist/cli.js", "managed-runtime-worker"}));
        try {
            // The pid list is not the whole answer, so the row says so.
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.workersCheck(
                    properties, () -> List.of(worker.toHandle(), unreadable), false);
            assertEquals(ManagedAgentPreflight.Status.WARN, check.status());
            assertEquals("1 Runtime worker(s) of an earlier run are alive (pid "
                    + worker.pid() + "); 1 more matching process(es) could not be"
                    + " inspected, so leftover workers were not ruled out",
                    check.detail());
            assertTrue(check.fix().endsWith(
                    "run --check as root or as the service account"), check.fix());
        } finally {
            reap(worker);
        }
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledOnOs(org.junit.jupiter.api.condition.OS.LINUX)
    void listsEveryLeftoverWorker(@TempDir Path directory) throws Exception {
        Path state = Files.createDirectory(directory.resolve("state"));
        ManagedAgentProperties properties = workerProperties(state);
        Path node = node(directory);
        Process first = worker(node, state);
        Process second = worker(node, state);
        try {
            // The order the scan reports them in is not the order printed.
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.workersCheck(
                    properties, () -> List.of(second.toHandle(), first.toHandle()), false);
            assertEquals(ManagedAgentPreflight.Status.WARN, check.status());
            long low = Math.min(first.pid(), second.pid());
            long high = Math.max(first.pid(), second.pid());
            assertEquals("2 Runtime worker(s) of an earlier run are alive (pid "
                    + low + ", " + high + ")", check.detail());
        } finally {
            first.destroyForcibly().waitFor();
            second.destroyForcibly().waitFor();
        }
    }

    // A ProcessHandle whose /proc entry this run cannot read or does not have.
    private static ProcessHandle handle(long pid, Optional<String> command,
            Optional<String[]> arguments) {
        ProcessHandle.Info info = new ProcessHandle.Info() {
            public Optional<String[]> arguments() {
                return arguments;
            }

            public Optional<String> command() {
                return command;
            }

            public Optional<String> commandLine() {
                return Optional.empty();
            }

            public Optional<String> user() {
                return Optional.empty();
            }

            public Optional<java.time.Instant> startInstant() {
                return Optional.empty();
            }

            public Optional<java.time.Duration> totalCpuDuration() {
                return Optional.empty();
            }
        };
        return new ProcessHandle() {
            public long pid() {
                return pid;
            }

            public Optional<ProcessHandle> parent() {
                return Optional.empty();
            }

            public ProcessHandle.Info info() {
                return info;
            }

            public java.util.stream.Stream<ProcessHandle> children() {
                return java.util.stream.Stream.empty();
            }

            public java.util.stream.Stream<ProcessHandle> descendants() {
                return java.util.stream.Stream.empty();
            }

            public boolean isAlive() {
                return true;
            }

            public java.util.concurrent.CompletableFuture<ProcessHandle> onExit() {
                return new java.util.concurrent.CompletableFuture<>();
            }

            public boolean supportsNormalTermination() {
                return false;
            }

            public boolean destroy() {
                return false;
            }

            public boolean destroyForcibly() {
                return false;
            }

            public int compareTo(ProcessHandle other) {
                return Long.compare(pid, other.pid());
            }
        };
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledOnOs(org.junit.jupiter.api.condition.OS.LINUX)
    void reportsAWorkerWhoseServerIsGoneEvenOnline(@TempDir Path directory)
            throws Exception {
        Path state = Files.createDirectory(directory.resolve("state"));
        ManagedAgentProperties properties = workerProperties(state);
        properties.getRuntimeBroker().setDurableLocalProcess(false);
        // An intermediate shell exits, so the worker is reparented as a
        // stopped server's workers are. It starts in the state directory, so
        // the check cannot run before a `cd` lands, and its output cannot hold
        // the launcher's pipe open.
        Process launcher = new ProcessBuilder("sh", "-c",
                "\"$1\" -c 'sleep 60 & wait' /opt/qwen-code/dist/cli.js"
                        + " managed-runtime-worker >/dev/null 2>&1 & echo $!", "launcher",
                node(directory).toString()).directory(state.toFile()).start();
        long orphan = Long.parseLong(new java.io.BufferedReader(
                new java.io.InputStreamReader(launcher.getInputStream(),
                        java.nio.charset.StandardCharsets.UTF_8)).readLine().trim());
        launcher.waitFor();
        ProcessHandle handle = ProcessHandle.of(orphan).orElseThrow();
        // $! names the child at fork; until its own exec lands, /proc holds
        // the launcher's argv and the worker does not match yet.
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (System.nanoTime() < deadline && !endsWithWorkerMarker(handle)) {
            Thread.sleep(10);
        }
        try {
            assertTrue(endsWithWorkerMarker(handle), "the worker reached its exec");
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.workersCheck(
                    properties, () -> List.of(handle), true);
            assertEquals(ManagedAgentPreflight.Status.WARN, check.status());
            assertEquals("1 Runtime worker(s) of an earlier run are alive (pid "
                    + orphan + ")", check.detail());
            // The service is running, so the fix does not advise a cgroup-wide
            // kill that would stop it.
            assertFalse(check.fix().startsWith("stop them before starting the server"),
                    check.fix());
            assertTrue(check.fix().startsWith("online: to reap them without stopping"
                    + " the service"), check.fix());
        } finally {
            handle.descendants().forEach(ProcessHandle::destroyForcibly);
            handle.destroyForcibly();
        }
    }

    private static boolean endsWithWorkerMarker(ProcessHandle handle) {
        return handle.info().arguments()
                .map(arguments -> arguments.length > 0
                        && "managed-runtime-worker".equals(
                                arguments[arguments.length - 1]))
                .orElse(false);
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledOnOs(org.junit.jupiter.api.condition.OS.LINUX)
    void findsWorkersThroughTheStateDirectorysRealPath(@TempDir Path directory)
            throws Exception {
        Path real = Files.createDirectory(directory.resolve("real"));
        Path link = Files.createSymbolicLink(directory.resolve("link"), real);
        ManagedAgentProperties properties = workerProperties(link);
        Path node = node(directory);
        Process linked = worker(node, real);
        Path removed = Files.createDirectory(directory.resolve("removed"));
        Process stale = worker(node, removed);
        try {
            assertEquals("1 Runtime worker(s) of an earlier run are alive (pid "
                    + linked.pid() + ")", ManagedAgentPreflight.workersCheck(
                            properties, () -> List.of(linked.toHandle()), false).detail());
            // A worker keeps a state directory that was removed and created again.
            Files.delete(removed);
            Files.createDirectory(removed);
            properties.getRuntimeBroker().setStateDirectory(removed.toString());
            assertEquals("1 Runtime worker(s) of an earlier run are alive (pid "
                    + stale.pid() + ")", ManagedAgentPreflight.workersCheck(
                            properties, () -> List.of(stale.toHandle()), false).detail());
        } finally {
            reap(linked);
            reap(stale);
        }
        properties.getRuntimeBroker().setStateDirectory(
                directory.resolve("missing").toString());
        ManagedAgentPreflight.Check missing =
                ManagedAgentPreflight.workersCheck(properties, List::of, false);
        assertEquals(ManagedAgentPreflight.Status.SKIP, missing.status());
        assertEquals("state directory does not exist yet", missing.detail());
        // A path that cannot be resolved is not a missing directory.
        Path file = Files.writeString(directory.resolve("file"), "");
        properties.getRuntimeBroker().setStateDirectory(file.resolve("child").toString());
        ManagedAgentPreflight.Check unreadable =
                ManagedAgentPreflight.workersCheck(properties, List::of, false);
        assertEquals(ManagedAgentPreflight.Status.WARN, unreadable.status());
        assertFalse(unreadable.detail().contains("does not exist yet"), unreadable.detail());
    }

    private static ManagedAgentProperties workerProperties(Path state) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setEnabled(true);
        properties.getRuntimeBroker().setStateDirectory(state.toString());
        return properties;
    }

    // A copy of sh named node: the command preflight reads is the
    // executable's own path.
    private static Path node(Path directory) throws IOException {
        Path node = Files.copy(Path.of("/bin/sh"), directory.resolve("node"),
                java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        node.toFile().setExecutable(true);
        return node;
    }

    // `sleep & wait` keeps the shell in place, as a lone command would not
    // under bash, so the worker's argv survives on every /bin/sh.
    private static Process worker(Path node, Path directory) throws IOException {
        return new ProcessBuilder(node.toString(), "-c", "sleep 60 & wait",
                "/opt/qwen-code/dist/cli.js", "managed-runtime-worker")
                .directory(directory.toFile()).start();
    }

    // The shell's `sleep 60` child outlives it unless it is killed too.
    private static void reap(Process process) throws InterruptedException {
        process.descendants().forEach(ProcessHandle::destroyForcibly);
        process.destroyForcibly().waitFor();
    }

    @Test
    void checksTheListenersInsteadOfBindingThemOnline() throws IOException {
        // Nothing accepts, so the backlog holds every connect below.
        try (java.net.ServerSocket listener = new java.net.ServerSocket(0, 50,
                java.net.InetAddress.getLoopbackAddress())) {
            ManagedAgentPreflight.Check open = ManagedAgentPreflight.listeningCheck(
                    "server", "0.0.0.0", listener.getLocalPort());
            assertEquals(ManagedAgentPreflight.Status.PASS, open.status());
            assertEquals("127.0.0.1:" + listener.getLocalPort()
                    + " is listening (online)", open.detail());
            int live = listener.getLocalPort();
            // --online=true reads as --online; another value fails.
            List<String> valued = statuses("--check", "--online=true", "--server.port=" + live);
            assertTrue(valued.contains("server-port:PASS"), valued.toString());
            List<String> invalid = statuses("--check", "--online=maybe", "--server.port=" + live);
            assertTrue(invalid.contains("online:FAIL"), invalid.toString());
            // A malformed value still runs the remaining rows offline.
            assertTrue(invalid.contains("server-port:FAIL"), invalid.toString());
            // The Broker port is checked the same way.
            List<String> broker = statuses("--check", "--online", "--server.port=" + live,
                    "--qwen.managed-agent.runtime-broker.enabled=true",
                    "--qwen.managed-agent.runtime-broker.port=" + live);
            assertTrue(broker.contains("broker-port:PASS"), broker.toString());
            // Offline, the busy port's fix points at --online.
            ManagedAgentPreflight.Check busy = ManagedAgentPreflight.checks(new String[] {
                    "--check", "--server.port=" + live, "--spring.datasource.url="})
                    .stream().filter(check -> check.name().equals("server-port"))
                    .findFirst().orElseThrow();
            assertEquals(ManagedAgentPreflight.Status.FAIL, busy.status());
            assertTrue(busy.fix().endsWith("run --check --online"), busy.fix());
        }
        int closed;
        try (java.net.ServerSocket probe = new java.net.ServerSocket(0)) {
            closed = probe.getLocalPort();
        }
        // --online=false turns the mode off again: a free port binds, and the
        // last spelling on the command line wins.
        List<String> offline = statuses("--check", "--online=false",
                "--server.port=" + closed);
        assertTrue(offline.contains("server-port:PASS"), offline.toString());
        assertFalse(offline.contains("online:FAIL"), offline.toString());
        List<String> lastWins = statuses("--check", "--online", "--online=false",
                "--server.port=" + closed);
        assertTrue(lastWins.contains("server-port:PASS"), lastWins.toString());
        ManagedAgentPreflight.Check silent = ManagedAgentPreflight.listeningCheck(
                "broker", "127.0.0.1", closed);
        assertEquals(ManagedAgentPreflight.Status.FAIL, silent.status());
        assertEquals("broker-port", silent.name());
        ManagedAgentPreflight.Check unresolved = ManagedAgentPreflight.listeningCheck(
                "server", "no-such-host.invalid", closed);
        assertEquals(ManagedAgentPreflight.Status.FAIL, unresolved.status());
        assertEquals("cannot resolve no-such-host.invalid", unresolved.detail());
        List<String> online = statuses("--check", "--online", "--server.port=" + closed,
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=" + closed);
        assertTrue(online.contains("server-port:FAIL"), online.toString());
        assertTrue(online.contains("broker-port:FAIL"), online.toString());
        // Without a local-process Runtime, online gives the offline reason.
        ManagedAgentPreflight.Check workers = ManagedAgentPreflight.checks(new String[] {
                "--check", "--online", "--server.port=" + closed, "--spring.datasource.url="})
                .stream().filter(check -> check.name().equals("workers"))
                .findFirst().orElseThrow();
        assertEquals("no local-process Runtime configured", workers.detail());
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledOnOs(org.junit.jupiter.api.condition.OS.LINUX)
    void runsTheWorkersRowOffline(@TempDir Path state) throws IOException {
        int free;
        try (java.net.ServerSocket probe = new java.net.ServerSocket(0)) {
            free = probe.getLocalPort();
        }
        ManagedAgentPreflight.Check workers = ManagedAgentPreflight.checks(new String[] {
                "--check", "--server.port=" + free, "--spring.datasource.url=",
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=0",
                "--qwen.managed-agent.runtime-broker.state-directory=" + state})
                .stream().filter(check -> check.name().equals("workers"))
                .findFirst().orElseThrow();
        assertEquals(ManagedAgentPreflight.Status.PASS, workers.status());
        assertEquals("no Runtime worker of an earlier run is alive", workers.detail());
    }

    @Test
    void takesAPortTheStoppedServerLeftInTimeWait() throws Exception {
        int port;
        try (java.net.ServerSocket listener = new java.net.ServerSocket()) {
            listener.bind(new InetSocketAddress("127.0.0.1", 0));
            port = listener.getLocalPort();
            try (java.net.Socket client = new java.net.Socket("127.0.0.1", port)) {
                // The server closes first, so the TIME_WAIT is on its port.
                listener.accept().close();
                assertEquals(-1, client.getInputStream().read());
            }
        }
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.portCheck("server", "127.0.0.1", port).status());
        try (java.net.ServerSocket live = new java.net.ServerSocket()) {
            live.bind(new InetSocketAddress("127.0.0.1", port));
            ManagedAgentPreflight.Check busy =
                    ManagedAgentPreflight.portCheck("server", "127.0.0.1", port);
            assertEquals(ManagedAgentPreflight.Status.FAIL, busy.status());
            assertEquals("server-port", busy.name());
        }
    }

    @Test
    void rejectsAPortOutsideTheTcpRange() {
        // A bad port must fail its own row, not throw out of the report.
        for (int port : new int[] {-1, 65536}) {
            ManagedAgentPreflight.Check offline =
                    ManagedAgentPreflight.portCheck("server", "127.0.0.1", port);
            assertEquals(ManagedAgentPreflight.Status.FAIL, offline.status());
            assertEquals("server-port", offline.name());
            assertEquals(port + " is not a TCP port", offline.detail());
            ManagedAgentPreflight.Check online =
                    ManagedAgentPreflight.listeningCheck("broker", "127.0.0.1", port);
            assertEquals(ManagedAgentPreflight.Status.FAIL, online.status());
            assertEquals("broker-port", online.name());
        }
    }

    private static List<String> statuses(String... args) {
        String[] withDatabase = java.util.Arrays.copyOf(args, args.length + 1);
        withDatabase[args.length] = "--spring.datasource.url=";
        return ManagedAgentPreflight.checks(withDatabase).stream()
                .map(check -> check.name() + ":" + check.status()).toList();
    }

    // The smallest envelope HostedHarnessClient accepts, as the Harness sends it.
    private static String capabilities(String digest, String v2Profiles) {
        return "{\"v\":1,\"qwenCodeVersion\":\"0.26.0\",\"transports\":[\"rest\"],"
                + "\"features\":[\"managed_session_journal_delta_v1\",\"hosted_harness_private_v1\"],"
                + "\"hostedHarness\":{\"protocolVersions\":{\"current\":1,\"supported\":[1]},"
                + "\"bootId\":\"" + java.util.UUID.randomUUID() + "\",\"capabilityDigest\":\""
                + digest + "\",\"lifecycleProtocolVersion\":1,\"lifecycleV2Profiles\":["
                + v2Profiles + "]}}";
    }

    private static HttpServer capabilitiesServer(String body) throws IOException {
        return capabilitiesServer(body, new ArrayList<>());
    }

    // Serves one body per /capabilities request, in order, the last one on.
    private static HttpServer capabilitiesServer(List<String> bodies) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        List<byte[]> bytes = bodies.stream()
                .map(body -> body.getBytes(java.nio.charset.StandardCharsets.UTF_8))
                .toList();
        AtomicInteger requests = new AtomicInteger();
        server.createContext("/capabilities", exchange -> {
            byte[] body = bytes.get(Math.min(requests.getAndIncrement(),
                    bytes.size() - 1));
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        return server;
    }

    // Records the Authorization header of every request, the probe's first.
    private static HttpServer capabilitiesServer(String body, List<String> authorizations)
            throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        byte[] bytes = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        List<String> recorded = Collections.synchronizedList(authorizations);
        server.createContext("/capabilities", exchange -> {
            recorded.add(exchange.getRequestHeaders().getFirst("Authorization"));
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        return server;
    }

    @Test
    void failsWhenTheHarnessAnswersAnError() throws IOException {
        HttpServer server = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/capabilities", exchange -> {
            exchange.sendResponseHeaders(503, -1);
            exchange.close();
        });
        server.start();
        try {
            assertEquals(ManagedAgentPreflight.Status.FAIL,
                    ManagedAgentPreflight.harnessCheck(harness(
                            "http://127.0.0.1:"
                                    + server.getAddress().getPort()), null).status());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void sendsTheConfiguredHarnessToken() throws IOException {
        List<String> authorizations = new ArrayList<>();
        HttpServer server = capabilitiesServer(capabilities(DIGEST, ""), authorizations);
        try {
            assertEquals(ManagedAgentPreflight.Status.PASS,
                    ManagedAgentPreflight.harnessCheck(harness(
                            "http://127.0.0.1:"
                                    + server.getAddress().getPort()), null).status());
            // The probe's, then the negotiation's: both send the configured
            // token.
            assertEquals(2, authorizations.size(), authorizations.toString());
            authorizations.forEach(actual ->
                    assertEquals("Bearer token", actual, authorizations.toString()));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void explainsARejectedHarnessToken(@TempDir Path directory)
            throws IOException {
        HttpServer server = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/capabilities", exchange -> {
            exchange.sendResponseHeaders(401, -1);
            exchange.close();
        });
        server.start();
        try {
            ManagedAgentPreflight.Check check =
                    ManagedAgentPreflight.harnessCheck(harness(
                            "http://127.0.0.1:"
                                    + server.getAddress().getPort()), null);
            assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
            assertTrue(check.detail().contains("401"));
            assertTrue(check.fix().contains(
                    "QWEN_MANAGED_AGENT_HARNESS_TOKEN"));
            Path file = credentialsFile(directory, "f".repeat(64), DIGEST);
            ManagedAgentProperties fromFile = fromFile(file,
                    "http://127.0.0.1:" + server.getAddress().getPort());
            assertEquals("set QWEN_SERVER_TOKEN in " + file + " to the"
                    + " token the Harness accepts",
                    ManagedAgentPreflight.harnessCheck(fromFile, null).fix());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void explainsARejectedNegotiationToken() throws IOException {
        // The probe is answered; the negotiation's own request is refused.
        HttpServer server = sequenceServer(401);
        try {
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.harnessCheck(
                    harness("http://127.0.0.1:" + server.getAddress().getPort()),
                    "0.26.0");
            assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
            assertTrue(check.detail().endsWith(
                    "/capabilities rejected the configured token on the"
                            + " compatibility request (401)"),
                    check.detail());
            assertEquals("set QWEN_MANAGED_AGENT_HARNESS_TOKEN to the token"
                    + " the Harness accepts", check.fix());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void failsWhenTheHarnessIsUnreachable() {
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.harnessCheck(
                        harness("http://127.0.0.1:1"), null).status());
    }

    @Test
    void keepsCredentialsInAMistypedHarnessUrlOutOfTheReport() throws IOException {
        // The parser's own message quotes the value it rejected, so the row
        // fails on the setting alone.
        for (String base : List.of("user:secret@127.0.0.1:1",
                " https://user:secret@127.0.0.1:1",
                "user:secret@harness.internal:8080",
                "https://svc:tok|en@127.0.0.1:1",
                "http://user:p@ss word@127.0.0.1:1",
                "http://user:secret@127.0.0.1:1/?query",
                "harness.internal:8080")) {
            ManagedAgentPreflight.Check check =
                    ManagedAgentPreflight.harnessCheck(harness(base), "0.26.0");
            assertEquals(ManagedAgentPreflight.Status.FAIL, check.status(),
                    check.detail());
            assertFalse(check.detail().contains("secret"), check.detail());
            assertFalse(check.detail().contains("user:"), check.detail());
            assertFalse(check.detail().contains("tok"), check.detail());
            assertFalse(check.fix().contains("secret"), check.fix());
            assertTrue(check.fix().startsWith(
                    "set QWEN_MANAGED_AGENT_HARNESS_BASE_URL"), check.fix());
            // A forgotten scheme is the likeliest typo, so the fix names http.
            assertTrue(check.fix().contains("http"), check.fix());
        }
        // One trailing space still parses to a reachable probe, but the server
        // parses the property untrimmed and cannot start with it.
        HttpServer live = capabilitiesServer(capabilities(DIGEST, ""));
        try {
            ManagedAgentPreflight.Check padded = ManagedAgentPreflight.harnessCheck(
                    harness("http://127.0.0.1:" + live.getAddress().getPort() + " "),
                    "0.26.0");
            assertEquals(ManagedAgentPreflight.Status.FAIL, padded.status(),
                    padded.detail());
            assertTrue(padded.fix().startsWith(
                    "set QWEN_MANAGED_AGENT_HARNESS_BASE_URL"), padded.fix());
        } finally {
            live.stop(0);
        }
    }

    @Test
    void keepsHarnessControlledTextOnOneBoundedLine() {
        assertEquals("??[2JPASS harness forged",
                ManagedAgentPreflight.printable("\n\u001b[2JPASS harness forged"));
        assertEquals("x".repeat(200) + "...",
                ManagedAgentPreflight.printable("x".repeat(500)));
        // The cut must not split a surrogate pair.
        assertEquals("x".repeat(199) + "\uD83D\uDE00" + "...",
                ManagedAgentPreflight.printable(
                        "x".repeat(199) + "\uD83D\uDE00y"));
    }

    @Test
    void keepsAnUnparsableCompatibilityAnswerOnOneLine() throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        byte[] envelope = capabilities(DIGEST, "")
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        // Invalid JSON: the newline and the escape are inside a string.
        byte[] hostile = ("{\"v\":1,\"broken\":\"line\n\u001b[2JPASS harness"
                + " forged\"}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        AtomicInteger requests = new AtomicInteger();
        server.createContext("/capabilities", exchange -> {
            byte[] body = requests.getAndIncrement() == 0 ? envelope : hostile;
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            // The negation is refused; the parser's message quotes the body,
            // so the row has to keep it on one line.
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.harnessCheck(
                    harness("http://127.0.0.1:" + server.getAddress().getPort()),
                    "0.26.0");
            assertEquals(ManagedAgentPreflight.Status.FAIL, check.status(),
                    check.detail());
            assertFalse(check.detail().contains("\n"), check.detail());
            assertFalse(check.detail().contains("\u001b"), check.detail());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void readsTheArgvARealRuntimeWorkerHas() {
        // EmbeddedRuntimeBroker builds [node, <entry>, managed-runtime-worker],
        // and ProcessHandle.Info.arguments() leaves out argv[0].
        assertTrue(ManagedAgentPreflight.isWorkerCommand("/opt/qwen-code/node/bin/node",
                new String[] {"/opt/qwen-code/dist/cli.js", "managed-runtime-worker"},
                null));
        assertFalse(ManagedAgentPreflight.isWorkerCommand("/opt/qwen-code/node/bin/node",
                new String[] {"managed-runtime-worker"}, null));
        // The executable is the operator-configured one, matched by prefix.
        assertTrue(ManagedAgentPreflight.isWorkerCommand("/usr/bin/nodejs",
                new String[] {"/opt/qwen-code/dist/cli.js", "managed-runtime-worker"},
                null));
        assertFalse(ManagedAgentPreflight.isWorkerCommand("tail",
                new String[] {"-f", "/dev/null", "managed-runtime-worker"}, null));
        // A renamed build the Broker was told to use is a worker too.
        assertTrue(ManagedAgentPreflight.isWorkerCommand("/opt/qwen/bin/qwen-runtime",
                new String[] {"/opt/qwen-code/dist/cli.js", "managed-runtime-worker"},
                "/opt/qwen/bin/qwen-runtime"));
        assertFalse(ManagedAgentPreflight.isWorkerCommand("/opt/qwen/bin/qwen-runtime",
                new String[] {"/opt/qwen-code/dist/cli.js", "managed-runtime-worker"},
                "/usr/bin/node"));
    }

    @Test
    void readsAReplacedServerBinaryAsTheServer() {
        assertTrue(ManagedAgentPreflight.isServerCommand("java"));
        // apt upgrade unlinks the binary under the running JVM.
        assertTrue(ManagedAgentPreflight.isServerCommand("java (deleted)"));
        assertFalse(ManagedAgentPreflight.isServerCommand("node"));
    }

    @Test
    void acceptsACompleteStaticBrokerConfiguration(@TempDir Path state) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        broker.setEnabled(true);
        broker.setToken("token");
        broker.setCredentialKeyId("reference-v1");
        broker.setCredentialKey(encoded(32));
        broker.setStateDirectory(state.toString());
        broker.setProvisioner("static");
        broker.setStaticEndpoint("http://127.0.0.1:1");
        broker.setStaticToken("token");
        List<ManagedAgentPreflight.Check> checks =
                ManagedAgentPreflight.brokerChecks(properties);
        assertTrue(checks.stream().noneMatch(check ->
                check.status() == ManagedAgentPreflight.Status.FAIL));
    }

    @Test
    void rejectsAnUndersizedCredentialKey(@TempDir Path state) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        broker.setEnabled(true);
        broker.setToken("token");
        broker.setCredentialKeyId("reference-v1");
        broker.setCredentialKey(encoded(31));
        broker.setStateDirectory(state.toString());
        broker.setProvisioner("static");
        broker.setStaticEndpoint("http://127.0.0.1:1");
        broker.setStaticToken("token");
        List<ManagedAgentPreflight.Check> checks =
                ManagedAgentPreflight.brokerChecks(properties);
        assertTrue(checks.stream().anyMatch(check ->
                check.status() == ManagedAgentPreflight.Status.FAIL));
    }

    @Test
    void treatsAMissingOptionalConfigAsAWarning() {
        assertEquals(ManagedAgentPreflight.Status.WARN,
                ManagedAgentPreflight.configFileCheck(
                        List.of("optional:file:/does-not-exist/"
                                + "application.yml")).status());
    }

    @Test
    void treatsAMissingRequiredConfigAsAFailure() {
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.configFileCheck(
                        List.of("file:/does-not-exist/application.yml"))
                        .status());
    }

    @Test
    void reportsTheEffectiveSessionStoreWiring() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getSessionStore().setEnabled(true);
        assertEquals(ManagedAgentPreflight.Status.SKIP,
                ManagedAgentPreflight.sessionStoreCheck(properties).status());
        properties.getHarness().setEnabled(true);
        ManagedAgentPreflight.Check url =
                ManagedAgentPreflight.sessionStoreCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.FAIL, url.status());
        assertTrue(url.fix().contains(
                "QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL"));
        properties.getSessionStore().setBaseUrl("http://127.0.0.1:8080");
        ManagedAgentPreflight.Check workspace =
                ManagedAgentPreflight.sessionStoreCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.FAIL, workspace.status());
        assertTrue(workspace.fix().contains(
                "QWEN_MANAGED_AGENT_WORKSPACE_CWD"));
        properties.getSessionStore().setWorkspaceId("workspace");
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.sessionStoreCheck(properties).status());
        properties.getSessionStore().setEnabled(false);
        assertEquals(ManagedAgentPreflight.Status.SKIP,
                ManagedAgentPreflight.sessionStoreCheck(properties).status());
    }

    @Test
    void derivesTheSessionStoreWiringFromTheShippedDefaults(
            @TempDir Path workspace) throws IOException {
        var environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(
                new org.springframework.core.env.MapPropertySource("test",
                        java.util.Map.of(
                                "QWEN_MANAGED_AGENT_HARNESS_ENABLED", "true",
                                "QWEN_MANAGED_AGENT_WORKSPACE_CWD",
                                workspace.toString(),
                                "server.port", "9090")));
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        ManagedAgentPreflight.loadConfiguration(environment, List.of(),
                checks);
        ManagedAgentProperties properties =
                ManagedAgentPreflight.bind(environment, checks);
        assertTrue(checks.isEmpty(), checks.toString());
        ManagedAgentPreflight.startupValidationCheck(properties);
        ManagedAgentPreflight.Check check =
                ManagedAgentPreflight.sessionStoreCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.PASS, check.status());
        assertEquals("http://127.0.0.1:9090",
                properties.getSessionStore().getBaseUrl());
        assertEquals(org.apache.commons.codec.digest.DigestUtils.sha256Hex(
                        workspace.toRealPath().toString().getBytes(
                                java.nio.charset.StandardCharsets.UTF_8))
                        .substring(0, 16),
                properties.getSessionStore().getWorkspaceId());
    }

    @Test
    void failsTheDerivedStoreUrlOfATlsListener(@TempDir Path workspace) {
        var environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(
                new org.springframework.core.env.MapPropertySource("test",
                        java.util.Map.of(
                                "QWEN_MANAGED_AGENT_HARNESS_ENABLED", "true",
                                "QWEN_MANAGED_AGENT_WORKSPACE_CWD",
                                workspace.toString(),
                                "server.ssl.bundle", "web")));
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        ManagedAgentPreflight.loadConfiguration(environment, List.of(),
                checks);
        ManagedAgentProperties properties =
                ManagedAgentPreflight.bind(environment, checks);
        ManagedAgentPreflight.startupValidationCheck(properties);
        ManagedAgentPreflight.Check check =
                ManagedAgentPreflight.sessionStoreCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
        assertEquals("base URL is empty", check.detail());
    }

    @Test
    void warnsWhenTheHarnessCredentialsFileIsShared(@TempDir Path directory)
            throws IOException {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        Path file = Files.writeString(directory.resolve("harness.env"), "");
        properties.getHarness().setCredentialsFile(file.toString());
        assertEquals("disabled",
                ManagedAgentPreflight.credentialsFileCheck(properties).detail());
        properties.getHarness().setEnabled(true);
        properties.getHarness().setCredentialsFile("");
        assertEquals("no Harness credentials configured",
                ManagedAgentPreflight.credentialsFileCheck(properties).detail());
        properties.getHarness().setCredentialsFile(file.toString());
        Files.setPosixFilePermissions(file,
                java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.credentialsFileCheck(properties).status());
        Files.setPosixFilePermissions(file,
                java.nio.file.attribute.PosixFilePermissions.fromString("rw-r-----"));
        ManagedAgentPreflight.Check shared =
                ManagedAgentPreflight.credentialsFileCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.WARN, shared.status());
        assertEquals("chmod 600 " + file, shared.fix());
        Files.setPosixFilePermissions(file,
                java.nio.file.attribute.PosixFilePermissions.fromString("rw----r--"));
        ManagedAgentPreflight.Check world =
                ManagedAgentPreflight.credentialsFileCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.WARN, world.status());
        assertEquals("chmod 600 " + file, world.fix());
        // The server reads it at startup, so an unreadable file fails.
        properties.getHarness().setCredentialsFile(
                directory.resolve("missing.env").toString());
        ManagedAgentPreflight.Check missing =
                ManagedAgentPreflight.credentialsFileCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.FAIL, missing.status());
        assertTrue(missing.fix().startsWith("chown it to the service account"));
        // An unusable path reports a row instead of ending the run.
        properties.getHarness().setCredentialsFile("/etc/qwen\0managed.env");
        assertEquals(ManagedAgentPreflight.Status.WARN,
                ManagedAgentPreflight.credentialsFileCheck(properties).status());
    }

    @Test
    void warnsWhenAConfigFileWithSecretsIsShared(@TempDir Path directory)
            throws IOException {
        Path file = Files.writeString(directory.resolve("application.yml"),
                "qwen:\n  managed-agent:\n    runtime-broker:\n"
                        + "      credential-key: 'x'\n");
        Files.setPosixFilePermissions(file,
                java.nio.file.attribute.PosixFilePermissions.fromString("rw-r-----"));
        ManagedAgentPreflight.Check shared = ManagedAgentPreflight
                .configFileCheck(List.of("file:" + file));
        assertEquals(ManagedAgentPreflight.Status.WARN, shared.status());
        assertEquals("chmod 600 " + file, shared.fix());
        Files.setPosixFilePermissions(file,
                java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        assertEquals(ManagedAgentPreflight.Status.PASS, ManagedAgentPreflight
                .configFileCheck(List.of("file:" + file)).status());
    }

    @Test
    void sendsTheTokenTheStartupValidationReadFromTheFile(
            @TempDir Path directory) throws IOException {
        String token = "f".repeat(64);
        Path file = credentialsFile(directory, token, DIGEST);
        List<String> authorizations = new ArrayList<>();
        HttpServer server = capabilitiesServer(capabilities(DIGEST, ""), authorizations);
        try {
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getHarness().setEnabled(true);
            properties.getSessionStore().setEnabled(true);
            properties.getHarness().setCredentialsFile(file.toString());
            properties.getHarness().setBaseUrl(
                    "http://127.0.0.1:" + server.getAddress().getPort());
            // run() adds the validation row before the Harness row.
            assertEquals(ManagedAgentPreflight.Status.PASS,
                    ManagedAgentPreflight.startupValidationCheck(properties)
                            .status());
            assertEquals(ManagedAgentPreflight.Status.PASS,
                    ManagedAgentPreflight.harnessCheck(properties, null).status());
            // The probe's, then the negotiation's: both send the file's token.
            assertEquals(2, authorizations.size(), authorizations.toString());
            authorizations.forEach(actual ->
                    assertEquals("Bearer " + token, actual,
                            authorizations.toString()));
            // A direct token beside the file is refused, so it is not sent.
            authorizations.clear();
            ManagedAgentProperties conflicting = new ManagedAgentProperties();
            conflicting.getHarness().setEnabled(true);
            conflicting.getSessionStore().setEnabled(true);
            conflicting.getHarness().setCredentialsFile(file.toString());
            conflicting.getHarness().setToken("e".repeat(64));
            conflicting.getHarness().setBaseUrl(
                    "http://127.0.0.1:" + server.getAddress().getPort());
            assertEquals(ManagedAgentPreflight.Status.FAIL,
                    ManagedAgentPreflight.startupValidationCheck(conflicting)
                            .status());
            ManagedAgentPreflight.Check skipped =
                    ManagedAgentPreflight.harnessCheck(conflicting, null);
            assertEquals(ManagedAgentPreflight.Status.SKIP, skipped.status());
            assertEquals("credentials were not read from " + file
                    + "; see the validation row", skipped.detail());
            assertTrue(authorizations.isEmpty(), authorizations.toString());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void listsTheCredentialsRowAfterTheHarnessRow(@TempDir Path directory)
            throws IOException {
        Path file = credentialsFile(directory, "f".repeat(64), DIGEST);
        Files.setPosixFilePermissions(file,
                java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        List<ManagedAgentPreflight.Check> checks = ManagedAgentPreflight
                .checks(new String[] {
                    "--qwen.managed-agent.harness.enabled=true",
                    "--qwen.managed-agent.harness.credentials-file=" + file,
                    "--qwen.managed-agent.harness.token=" + "e".repeat(64),
                    "--qwen.managed-agent.runtime-broker.enabled=false",
                    "--server.port=0",
                    "--spring.datasource.url=",
                });
        List<String> rows = checks.stream()
                .map(ManagedAgentPreflight.Check::name).toList();
        int harness = rows.indexOf("harness");
        assertEquals(harness + 1, rows.indexOf("credentials"), rows.toString());
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                checks.get(rows.indexOf("validation")).status());
        assertEquals(ManagedAgentPreflight.Status.SKIP,
                checks.get(harness).status());
        assertEquals(ManagedAgentPreflight.Status.PASS,
                checks.get(harness + 1).status());
    }

    @Test
    void refusesTheShippedPlaceholderToken() {
        ManagedAgentProperties properties = harness("http://127.0.0.1:1");
        properties.getHarness().setToken("replace-with-a-private-random-token");
        ManagedAgentPreflight.Check check =
                ManagedAgentPreflight.harnessCheck(properties, null);
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
        assertEquals("token is still the shipped template placeholder",
                check.detail());
    }

    @Test
    void pointsHarnessCredentialFixesAtTheCredentialsFile(
            @TempDir Path directory) throws IOException {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        assertEquals("set QWEN_MANAGED_AGENT_HARNESS_TOKEN",
                ManagedAgentPreflight.harnessCheck(properties, null).fix());
        properties.getHarness().setToken("token");
        assertEquals("set QWEN_MANAGED_AGENT_CAPABILITY_DIGEST",
                ManagedAgentPreflight.harnessCheck(properties, null).fix());
        Path placeholderToken = credentialsFile(directory,
                "replace-with-a-private-random-token", DIGEST);
        assertEquals("set QWEN_SERVER_TOKEN in " + placeholderToken,
                ManagedAgentPreflight.harnessCheck(
                        fromFile(placeholderToken, "http://127.0.0.1:1"), null).fix());
        Path placeholderDigest = credentialsFile(directory, "token",
                "sha256:replace-with-64-lowercase-hex");
        assertEquals("set QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST in "
                + placeholderDigest,
                ManagedAgentPreflight.harnessCheck(
                        fromFile(placeholderDigest, "http://127.0.0.1:1"), null).fix());
        properties.getRuntimeBroker().setEnabled(true);
        assertEquals("set QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN",
                ManagedAgentPreflight.brokerChecks(properties).get(0).fix());
        // A file startup has not read gets no advice to edit it.
        properties.getHarness().setCredentialsFile("/etc/harness.env");
        assertEquals("credentials were not read from /etc/harness.env;"
                + " see the validation row",
                ManagedAgentPreflight.brokerChecks(properties).get(0).fix());
        // Nor does one it never reads, while the Harness is disabled.
        properties.getHarness().setEnabled(false);
        assertEquals("set QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN",
                ManagedAgentPreflight.brokerChecks(properties).get(0).fix());
        // The Harness takes the Broker URL and token from the file together.
        Path textOnly = credentialsFile(directory, "token", DIGEST);
        ManagedAgentProperties bound = fromFile(textOnly, "http://127.0.0.1:1");
        bound.getRuntimeBroker().setEnabled(true);
        List<ManagedAgentPreflight.Check> checks =
                ManagedAgentPreflight.brokerChecks(bound);
        assertEquals("set QWEN_MANAGED_RUNTIME_BROKER_URL and"
                + " QWEN_MANAGED_RUNTIME_BROKER_TOKEN in " + textOnly,
                checks.get(0).fix());
        assertEquals(ManagedAgentPreflight.Status.WARN, checks.get(1).status());
        assertEquals(textOnly + " gives the Hosted Harness no Broker URL",
                checks.get(1).detail());
    }

    @Test
    void comparesTheHarnessBrokerUrlWithTheBrokerAddress(
            @TempDir Path directory) throws IOException {
        Path file = Files.writeString(directory.resolve("harness.env"),
                "QWEN_SERVER_TOKEN=token\nQWEN_HOSTED_HARNESS_CAPABILITY_DIGEST="
                        + DIGEST + "\nQWEN_MANAGED_RUNTIME_BROKER_URL="
                        + "http://127.0.0.1:4182\nQWEN_MANAGED_RUNTIME_BROKER_TOKEN=broker\n");
        ManagedAgentProperties properties = fromFile(file, "http://127.0.0.1:1");
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        broker.setEnabled(true);
        assertEquals(ManagedAgentPreflight.Status.PASS,
                urlRow(properties).status());
        // The Broker moved through its own settings; the file still names
        // 4182, which only a proxy could forward, so preflight warns.
        broker.setPort(4200);
        ManagedAgentPreflight.Check moved = urlRow(properties);
        assertEquals(ManagedAgentPreflight.Status.WARN, moved.status());
        assertEquals("the Hosted Harness dials http://127.0.0.1:4182, not the"
                + " Broker's listener at 127.0.0.1:4200; a proxy may forward it,"
                + " which preflight cannot verify", moved.detail());
        assertEquals("point QWEN_MANAGED_RUNTIME_BROKER_URL in " + file
                + " at http://127.0.0.1:4200, unless a proxy forwards"
                + " http://127.0.0.1:4182 there", moved.fix());
        // The URL the fix names passes once written to the file.
        assertEquals(ManagedAgentPreflight.Status.PASS,
                urlCheck("http://127.0.0.1:4200", broker).status());
        broker.setPort(4182);
        // A non-loopback bind sits behind a TLS-terminating proxy, which the
        // Harness reaches over https; the fix never names plain http there.
        broker.setHost("192.0.2.7");
        broker.setAllowNonLoopback(true);
        ManagedAgentPreflight.Check proxied =
                urlCheck("https://198.51.100.5:8443", broker);
        assertEquals(ManagedAgentPreflight.Status.WARN, proxied.status());
        assertEquals("check that a proxy forwards https://198.51.100.5:8443"
                + " to 192.0.2.7:4182", proxied.fix());
        ManagedAgentPreflight.Check plain =
                urlCheck("http://192.0.2.7:4182", broker);
        assertEquals(ManagedAgentPreflight.Status.FAIL, plain.status());
        assertEquals("the Hosted Harness refuses http://192.0.2.7:4182,"
                + " because it uses plain http outside the loopback interface",
                plain.detail());
        assertEquals("point QWEN_MANAGED_RUNTIME_BROKER_URL in f at the https"
                + " URL of the TLS-terminating proxy in front of"
                + " 192.0.2.7:4182", plain.fix());
        // A wildcard bind serves this machine's addresses, not any address,
        // and the Harness dials it over loopback.
        broker.setHost("0.0.0.0");
        assertEquals(ManagedAgentPreflight.Status.PASS,
                urlRow(properties).status());
        assertEquals(ManagedAgentPreflight.Status.WARN,
                urlCheck("http://127.0.0.2:4183", broker).status());
        ManagedAgentPreflight.Check outside =
                urlCheck("http://192.0.2.7:4182", broker);
        assertEquals(ManagedAgentPreflight.Status.FAIL, outside.status());
        assertEquals("point QWEN_MANAGED_RUNTIME_BROKER_URL in f at"
                + " http://127.0.0.1:4182", outside.fix());
        // The IPv4 wildcard takes IPv6 only from a dual-stack JVM, which
        // preflight cannot confirm; the IPv4 URL reaches it either way.
        ManagedAgentPreflight.Check ipv6 = urlCheck("http://[::1]:4182", broker);
        assertEquals(ManagedAgentPreflight.Status.WARN, ipv6.status());
        assertEquals("the Hosted Harness dials http://[::1]:4182 over IPv6, but"
                + " the Broker binds 0.0.0.0, which takes IPv6 only when its"
                + " JVM listens on both families, unlike under"
                + " -Djava.net.preferIPv4Stack=true", ipv6.detail());
        assertEquals("point QWEN_MANAGED_RUNTIME_BROKER_URL in f at"
                + " http://127.0.0.1:4182", ipv6.fix());
        // Over https, a dual-stack JVM's plain socket would break TLS, but an
        // IPv4-only one leaves [::1]:4182 to another listener, such as a TLS
        // proxy, so this stays a warning too.
        ManagedAgentPreflight.Check tlsIpv6 =
                urlCheck("https://[::1]:4182", broker);
        assertEquals(ManagedAgentPreflight.Status.WARN, tlsIpv6.status());
        assertEquals("the Hosted Harness dials https://[::1]:4182 over IPv6:"
                + " a Broker JVM that listens on both families takes it on the"
                + " plain-HTTP socket at 0.0.0.0:4182, where TLS cannot"
                + " connect, while under -Djava.net.preferIPv4Stack=true"
                + " another listener, such as a TLS proxy, may hold it",
                tlsIpv6.detail());
        assertEquals("point QWEN_MANAGED_RUNTIME_BROKER_URL in f at"
                + " http://127.0.0.1:4182, unless a proxy forwards"
                + " https://[::1]:4182 there", tlsIpv6.fix());
        // A URL the Broker's own socket takes in either mode still fails over
        // https.
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                urlCheck("https://127.0.0.1:4182", broker).status());
        // The JDK binds :: only on a dual-stack socket, which takes IPv4 too.
        broker.setHost("::");
        assertEquals(ManagedAgentPreflight.Status.PASS,
                urlCheck("http://127.0.0.1:4182", broker).status());
        assertEquals(ManagedAgentPreflight.Status.PASS,
                urlCheck("http://[::1]:4182", broker).status());
        broker.setAllowNonLoopback(false);
        broker.setHost("127.0.0.1");
        assertEquals(ManagedAgentPreflight.Status.PASS,
                urlCheck("http://localhost:4182", broker).status());
        assertEquals(ManagedAgentPreflight.Status.PASS,
                urlCheck("http://127.0.0.1:4182/", broker).status());
        // A specific bind serves its own address, not every loopback one.
        assertEquals(ManagedAgentPreflight.Status.WARN,
                urlCheck("http://127.0.0.2:4182", broker).status());
        // The Broker speaks plain HTTP, so https to its own socket fails,
        // while https to another port may be a TLS front end.
        ManagedAgentPreflight.Check tls = urlCheck("https://127.0.0.1:4182", broker);
        assertEquals(ManagedAgentPreflight.Status.FAIL, tls.status());
        assertEquals("the Hosted Harness dials https://127.0.0.1:4182, but the"
                + " Broker serves plain HTTP there, so TLS cannot connect",
                tls.detail());
        assertEquals(ManagedAgentPreflight.Status.WARN,
                urlCheck("https://127.0.0.1:8443", broker).status());
        assertEquals(ManagedAgentPreflight.Status.WARN,
                urlCheck("http://127.0.0.1", broker).status());
        // The Harness accepts only an http or https origin.
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                urlCheck("127.0.0.1:4182", broker).status());
        ManagedAgentPreflight.Check ftp = urlCheck("ftp://127.0.0.1:4182", broker);
        assertEquals(ManagedAgentPreflight.Status.FAIL, ftp.status());
        assertEquals("the Hosted Harness refuses ftp://127.0.0.1:4182, which is"
                + " not an http or https origin", ftp.detail());
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                urlCheck("http://127.0.0.1:4182/broker", broker).status());
        // A host name the URI parser takes only as a registry authority is
        // still read as a host.
        assertEquals("the Hosted Harness refuses http://qwen_broker:4182,"
                + " because it uses plain http outside the loopback interface",
                urlCheck("http://qwen_broker:4182", broker).detail());
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                urlCheck("https://qwen_broker:port", broker).status());
        // IPv6 loopback is one socket family; the IPv4 URL does not reach it.
        broker.setHost("::1");
        assertEquals(ManagedAgentPreflight.Status.PASS,
                urlCheck("http://[::1]:4182", broker).status());
        ManagedAgentPreflight.Check family =
                urlCheck("http://127.0.0.1:4182", broker);
        assertEquals(ManagedAgentPreflight.Status.WARN, family.status());
        assertEquals("point QWEN_MANAGED_RUNTIME_BROKER_URL in f at"
                + " http://[::1]:4182, unless a proxy forwards"
                + " http://127.0.0.1:4182 there", family.fix());
        assertEquals("the Hosted Harness dials http://127.0.0.1:4182, not the"
                + " Broker's listener at [::1]:4182; a proxy may forward it,"
                + " which preflight cannot verify", family.detail());
        broker.setHost("2001:db8::1");
        broker.setAllowNonLoopback(true);
        assertEquals("check that a proxy forwards https://198.51.100.5:8443"
                + " to [2001:db8::1]:4182",
                urlCheck("https://198.51.100.5:8443", broker).fix());
    }

    @Test
    void readsTheBrokerUrlTheWayTheHarnessDoes() {
        ManagedAgentProperties.RuntimeBroker broker =
                new ManagedAgentProperties().getRuntimeBroker();
        broker.setHost("127.0.0.1");
        broker.setPort(4182);
        // Node's URL parser folds each of these into the Broker's origin.
        for (String url : List.of("http://127.1:4182", "http://2130706433:4182",
                "http:/127.0.0.1:4182", "http:///127.0.0.1:4182",
                "http://127.0.0.1:4182/./", "http://127.0.0.1:4182/proxy/..")) {
            assertEquals(ManagedAgentPreflight.Status.PASS,
                    urlCheck(url, broker).status(), url);
        }
        // And refuses these, so the Harness never starts.
        for (String url : List.of("http://127.0.0.08:4182",
                "http://127.0.0.1:65536", "http://127.0.0.1:99999")) {
            ManagedAgentPreflight.Check check = urlCheck(url, broker);
            assertEquals(ManagedAgentPreflight.Status.FAIL, check.status(), url);
            assertEquals("the Hosted Harness refuses " + url
                    + ", which is not a valid URL", check.detail());
        }
        // Only whether the Harness accepts an https host with an xn-- label
        // depends on IDNA; plain http to one is refused either way.
        assertEquals(ManagedAgentPreflight.Status.WARN,
                urlCheck("https://xn--bcher-kva.example:4182", broker).status());
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                urlCheck("http://xn--bcher-kva.example:4182", broker).status());
        broker.setHost("::1");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                urlCheck("http://::1:4182", broker).status());
        // A leading zero makes an octet octal: 010 is 8, not the bound 10.
        broker.setHost("127.0.0.10");
        assertEquals(ManagedAgentPreflight.Status.WARN,
                urlCheck("http://127.0.0.010:4182", broker).status());
        assertEquals(ManagedAgentPreflight.Status.PASS,
                urlCheck("http://127.0.0.10:4182", broker).status());
        // The fix names the bound address, which the Harness accepts
        // whatever the configured spelling.
        broker.setHost("::ffff:127.0.0.1");
        assertEquals("point QWEN_MANAGED_RUNTIME_BROKER_URL in f at"
                + " http://127.0.0.1:4182, unless a proxy forwards"
                + " http://127.0.0.1:4200 there",
                urlCheck("http://127.0.0.1:4200", broker).fix());
        assertEquals(ManagedAgentPreflight.Status.PASS,
                urlCheck("http://127.0.0.1:4182", broker).status());
    }

    @Test
    void refusesANonLoopbackBrokerListenerWithoutTheOptIn() {
        ManagedAgentProperties.RuntimeBroker broker =
                new ManagedAgentProperties().getRuntimeBroker();
        broker.setHost("127.0.0.1");
        assertNull(ManagedAgentPreflight.brokerListenCheck(broker));
        broker.setHost("::1");
        assertNull(ManagedAgentPreflight.brokerListenCheck(broker));
        broker.setHost("0.0.0.0");
        ManagedAgentPreflight.Check wildcard =
                ManagedAgentPreflight.brokerListenCheck(broker);
        assertEquals(ManagedAgentPreflight.Status.FAIL, wildcard.status());
        assertEquals("the Broker refuses to listen on 0.0.0.0 without"
                + " runtime-broker.allow-non-loopback", wildcard.detail());
        assertEquals("bind 127.0.0.1, or set"
                + " QWEN_MANAGED_AGENT_RUNTIME_BROKER_ALLOW_NON_LOOPBACK=true"
                + " behind a TLS-terminating proxy", wildcard.fix());
        broker.setHost("192.0.2.7");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.brokerListenCheck(broker).status());
        broker.setAllowNonLoopback(true);
        assertNull(ManagedAgentPreflight.brokerListenCheck(broker));
        broker.setHost("0.0.0.0");
        assertNull(ManagedAgentPreflight.brokerListenCheck(broker));
        // The Broker rows carry it.
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setEnabled(true);
        properties.getRuntimeBroker().setHost("0.0.0.0");
        assertTrue(ManagedAgentPreflight.brokerChecks(properties).stream()
                .anyMatch(check -> check.status() == ManagedAgentPreflight.Status.FAIL
                        && check.detail().equals(wildcard.detail())));
    }

    private static ManagedAgentPreflight.Check urlCheck(String url,
            ManagedAgentProperties.RuntimeBroker broker) {
        return ManagedAgentPreflight.harnessBrokerUrlCheck(url, broker, "f");
    }

    private static ManagedAgentPreflight.Check urlRow(
            ManagedAgentProperties properties) {
        return ManagedAgentPreflight.brokerChecks(properties).stream()
                .filter(check -> check.name().equals("broker-url"))
                .findFirst().orElseThrow();
    }

    @Test
    void resolvesTheServiceUserTheFileRowsCheckFor() {
        ManagedAgentPreflight.AccessCheck unset =
                ManagedAgentPreflight.serviceUserCheck("", "root", name -> {
                    throw new AssertionError("no lookup without a name");
                });
        assertEquals(ManagedAgentPreflight.Status.SKIP, unset.check().status());
        assertEquals("not set; file rows check access as root",
                unset.check().detail());
        assertNull(unset.account());
        // Preflight running as the account checks as itself.
        ManagedAgentPreflight.AccessCheck self =
                ManagedAgentPreflight.serviceUserCheck("svc", "svc", name -> {
                    throw new AssertionError("no lookup for this process");
                });
        assertEquals(ManagedAgentPreflight.Status.PASS, self.check().status());
        assertNull(self.account());
        ManagedAgentPreflight.AccessCheck found =
                ManagedAgentPreflight.serviceUserCheck("svc", "root", name ->
                        Optional.of(new ServiceAccount(name, Set.of("svc", "adm"))));
        assertEquals("svc (groups adm, svc)", found.check().detail());
        assertEquals("svc", found.account().name());
        ManagedAgentPreflight.AccessCheck missing =
                ManagedAgentPreflight.serviceUserCheck("svc", "root",
                        name -> Optional.empty());
        assertEquals(ManagedAgentPreflight.Status.FAIL, missing.check().status());
        assertEquals("svc does not exist", missing.check().detail());
        assertNull(missing.account());
        ManagedAgentPreflight.AccessCheck unknown =
                ManagedAgentPreflight.serviceUserCheck("svc", "root", name -> {
                    throw new IOException("no id");
                });
        assertEquals(ManagedAgentPreflight.Status.WARN, unknown.check().status());
        assertEquals("cannot look up svc; file rows check access as root",
                unknown.check().detail());
        assertNull(unknown.account());
    }

    @Test
    @org.junit.jupiter.api.condition.DisabledOnOs(
            org.junit.jupiter.api.condition.OS.WINDOWS)
    void checksTheSecretFilesAsTheServiceUser(@TempDir Path directory)
            throws IOException {
        Files.setPosixFilePermissions(directory,
                java.nio.file.attribute.PosixFilePermissions.fromString("rwx--x--x"));
        Path harness = Files.writeString(directory.resolve("harness.env"), "");
        Path application = Files.writeString(
                directory.resolve("application.yml"), "credential-key: x\n");
        for (Path file : List.of(harness, application)) {
            Files.setPosixFilePermissions(file,
                    java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        }
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getHarness().setCredentialsFile(harness.toString());
        String owner = Files.getOwner(harness).getName();
        ServiceAccount stranger =
                new ServiceAccount("qwen-preflight-stranger", Set.of());
        // This process owns both files, so it alone can read them.
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.credentialsFileCheck(properties).status());
        ManagedAgentPreflight.Check credentials =
                ManagedAgentPreflight.credentialsFileCheck(properties, stranger);
        assertEquals(ManagedAgentPreflight.Status.FAIL, credentials.status());
        assertEquals(harness + " is not readable by qwen-preflight-stranger",
                credentials.detail());
        assertEquals("chown qwen-preflight-stranger " + harness + ", chmod 600 "
                + harness + ", and let qwen-preflight-stranger enter every"
                + " directory on its path, following symbolic links",
                credentials.fix());
        ManagedAgentPreflight.Check config = ManagedAgentPreflight.configFileCheck(
                List.of("file:" + application), stranger);
        assertEquals(ManagedAgentPreflight.Status.FAIL, config.status());
        assertEquals(application + " is not readable by qwen-preflight-stranger",
                config.detail());
        ServiceAccount ownerAccount = new ServiceAccount(owner, Set.of());
        assertEquals(ManagedAgentPreflight.Status.PASS, ManagedAgentPreflight
                .credentialsFileCheck(properties, ownerAccount).status());
        assertEquals(ManagedAgentPreflight.Status.PASS, ManagedAgentPreflight
                .configFileCheck(List.of("file:" + application), ownerAccount)
                .status());
    }

    @Test
    void requiresTheSessionStoreForWorkspaceFiles() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setApprovalMode("yolo");
        properties.getSessionStore().setEnabled(false);
        properties.getRuntimeBroker().setEnabled(true);
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void acceptsWorkspaceFilesWhenBothServicesAreEnabled() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setApprovalMode("yolo");
        properties.getSessionStore().setEnabled(true);
        properties.getRuntimeBroker().setEnabled(true);
        properties.getRuntimeBroker()
                .setWorkspaceCreationRoot("/tmp/workspace-root");
        properties.getRuntimeBroker()
                .setVerifiedWorkspaceRecoveryEnabled(true);
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void rejectsWorkspaceFilesWithoutAMountOrCreationRoot() {
        ManagedAgentProperties properties = toolProperties();
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void rejectsWorkspaceCreationWithoutVerifiedRecovery() {
        ManagedAgentProperties properties = toolProperties();
        properties.getRuntimeBroker()
                .setWorkspaceCreationRoot("/tmp/workspace-root");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void warnsWhenTheToolPathUsesAnotherProvisioner() {
        ManagedAgentProperties properties = toolProperties();
        properties.getRuntimeBroker().setProvisioner("kubernetes-workspace");
        assertEquals(ManagedAgentPreflight.Status.WARN,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void rejectsWorkspaceFilesWithTheStaticProvisioner() {
        ManagedAgentProperties properties = toolProperties();
        properties.getRuntimeBroker().setProvisioner("static");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void rejectsSshWithoutNodes() {
        ManagedAgentProperties properties = toolProperties();
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                        "tenant-1", "storage-1", "/tmp/workspace-mount")));
        properties.getRuntimeBroker().getSsh().setEnabled(true);
        ManagedAgentPreflight.Check check =
                ManagedAgentPreflight.toolPathCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
        assertTrue(check.detail().contains("SSH Runtime"));
    }

    @Test
    void rejectsWorkspaceCreationWithoutWorkspaceFiles() {
        ManagedAgentProperties properties = toolProperties();
        properties.getHarness().setWorkspaceFilesEnabled(false);
        properties.getRuntimeBroker()
                .setWorkspaceCreationRoot("/tmp/workspace-root");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void rejectsAnUnsupportedIsolationClass() {
        ManagedAgentProperties properties = toolProperties();
        properties.getRuntimeBroker()
                .setWorkspaceCreationRoot("/tmp/workspace-root");
        properties.getRuntimeBroker()
                .setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setIsolationClass("tenant");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void commandLineArgumentsOverrideTheEnvironment() {
        var environment = ManagedAgentPreflight.baseEnvironment(new String[] {
                "--server.address=0.0.0.0",
                "--qwen.managed-agent.auth.mode=open"});
        assertEquals("0.0.0.0", environment.getProperty("server.address"));
        assertEquals("open",
                environment.getProperty("qwen.managed-agent.auth.mode"));
    }

    @Test
    void laterExternalYamlOverridesEarlierWithoutDroppingKeys(
            @TempDir Path directory) throws IOException {
        Path first = Files.writeString(directory.resolve("first.yml"),
                "server:\n  address: 0.0.0.0\n");
        Path second = Files.writeString(directory.resolve("second.yml"),
                "server:\n  port: 0\n");
        var environment = new StandardEnvironment();
        ManagedAgentPreflight.loadConfiguration(environment,
                List.of(first.toString(), second.toString()),
                new ArrayList<>());
        assertEquals("0.0.0.0", environment.getProperty("server.address"));
        assertEquals("0", environment.getProperty("server.port"));
    }

    @Test
    void rejectsAMissingPerformanceSchemaGrant() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("spring.datasource.url",
                "jdbc:h2:mem:preflight-grant;DB_CLOSE_DELAY=-1");
        environment.setProperty("spring.datasource.username", "sa");
        environment.setProperty("spring.datasource.password", "");
        ManagedAgentPreflight.Check check =
                ManagedAgentPreflight.databaseCheck(environment);
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
        assertTrue(check.detail().contains("performance_schema grant missing"));
    }

    @Test
    void findsTheManifestBesideTheOuterJar(@TempDir Path distribution)
            throws IOException {
        Path lib = Files.createDirectories(distribution.resolve("lib"));
        Path jar = Files.writeString(lib.resolve("server.jar"), "server");
        Path manifest = distribution.resolve("manifest.json");
        Files.writeString(manifest,
                "{\"compatibility\":{\"databaseSchema\":"
                        + "{\"latestMigrationVersion\":\"999\"}}}");
        assertEquals(manifest,
                ManagedAgentPreflight.findManifest(jar.toString()));
        Path relative = Path.of("").toAbsolutePath()
                .relativize(jar.toAbsolutePath());
        assertEquals(manifest,
                ManagedAgentPreflight.findManifest(relative.toString()));
        assertEquals("999",
                ManagedAgentPreflight.expectedSchemaVersion(manifest));
    }

    @Test
    void readsAnOlderSchemaAsTheUpgradeTheFirstStartFinishes() {
        ManagedAgentPreflight.SchemaValidation valid = () -> {};
        for (String[] same : new String[][] {
                {"2", "2"}, {null, "2"}, {"2", null}, {"1.0", "1"}}) {
            assertEquals(ManagedAgentPreflight.Status.PASS,
                    ManagedAgentPreflight.schemaCheck(same[0], same[1], valid)
                            .status(), same[0] + "/" + same[1]);
        }
        // Flyway order, not text order: 1.9 comes before 1.10.
        ManagedAgentPreflight.Check older =
                ManagedAgentPreflight.schemaCheck("1.9", "1.10", valid);
        assertEquals(ManagedAgentPreflight.Status.WARN, older.status());
        assertEquals("schema=1.9; the first start migrates it to 1.10,"
                + " which only a database backup undoes", older.detail());
        ManagedAgentPreflight.Check newer =
                ManagedAgentPreflight.schemaCheck("10", "9", valid);
        assertEquals(ManagedAgentPreflight.Status.FAIL, newer.status());
        assertEquals("schema=10 but the manifest expects 9", newer.detail());
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.schemaCheck("2a", "2", valid).status());
    }

    @Test
    void validatesASchemaAtThisReleasesVersionAsTheServerDoes() {
        int[] runs = {0};
        ManagedAgentPreflight.SchemaValidation rewritten = () -> {
            runs[0]++;
            throw new SQLException(
                    "Managed schema column is missing: ma_session.x");
        };
        ManagedAgentPreflight.Check check =
                ManagedAgentPreflight.schemaCheck("1", "1", rewritten);
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
        assertEquals("schema=1 does not match this distribution: Managed"
                + " schema column is missing: ma_session.x", check.detail());
        // Neither a fresh database nor one an upgrade has yet to migrate is
        // held to this release's baseline.
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.schemaCheck(null, "1", rewritten)
                        .status());
        assertEquals(ManagedAgentPreflight.Status.WARN,
                ManagedAgentPreflight.schemaCheck("1", "2", rewritten)
                        .status());
        assertEquals(1, runs[0]);
    }

    @Test
    void holdsAMigratedDatabaseToTheBaselineThisReleaseShips() throws Exception {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:preflight-schema-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure()
                .dataSource(source)
                .locations(ManagedSchema.FLYWAY_LOCATION)
                .load()
                .migrate();
        try (Connection connection = source.getConnection()) {
            assertEquals(ManagedAgentPreflight.Status.PASS,
                    ManagedAgentPreflight.schemaCheck(connection, "1").status());
            // What a release that rewrote its baseline finds in the database.
            try (Statement statement = connection.createStatement()) {
                statement.execute("ALTER TABLE ma_operation"
                        + " DROP CONSTRAINT ck_ma_operation_kind");
            }
            ManagedAgentPreflight.Check rewritten =
                    ManagedAgentPreflight.schemaCheck(connection, "1");
            assertEquals(ManagedAgentPreflight.Status.FAIL, rewritten.status());
            assertTrue(rewritten.detail().startsWith(
                    "schema=1 does not match this distribution: "),
                    rewritten.detail());
        }
    }

    @Test
    void rejectsOpenModeOnANonLoopbackBind() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "0.0.0.0");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("open");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment, properties)
                        .status());
    }

    @Test
    void rejectsAContextPath() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "127.0.0.1");
        environment.setProperty("server.servlet.context-path", "/prefix");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment,
                        new ManagedAgentProperties()).status());
    }

    @Test
    void rejectsAServletPath() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "127.0.0.1");
        environment.setProperty("spring.mvc.servlet.path", "/api");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment,
                        new ManagedAgentProperties()).status());
    }

    @Test
    void acceptsAutoModeOnANonLoopbackBindWithInsecureOverride() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "0.0.0.0");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("auto");
        properties.getAuth().setAllowInsecureBind(true);
        assertNotEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment, properties)
                        .status());
    }

    @Test
    void rejectsAnUnknownAuthMode() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "0.0.0.0");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("typo");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment, properties)
                        .status());
    }

    @Test
    void rejectsAShortSigningKey() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "0.0.0.0");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("signed");
        properties.getAuth().setSigningKey("x".repeat(31));
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment, properties)
                        .status());
    }

    @Test
    void acceptsTheDefaultStartupProperties() {
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.startupValidationCheck(
                        new ManagedAgentProperties()).status());
    }

    @Test
    void rejectsAnOutOfRangeApprovalTimeout() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setApprovalTimeout(Duration.ofMillis(500));
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.startupValidationCheck(properties)
                        .status());
    }

    @Test
    void rejectsAnInvalidBoundSessionIsolation() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setBoundSessionIsolationClass("tenant");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.startupValidationCheck(properties)
                        .status());
    }

    @Test
    void rejectsSshWithoutWorkspaceFiles() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().getSsh().setEnabled(true);
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.startupValidationCheck(properties)
                        .status());
    }

    private static ManagedAgentProperties toolProperties() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setApprovalMode("yolo");
        properties.getSessionStore().setEnabled(true);
        properties.getRuntimeBroker().setEnabled(true);
        return properties;
    }

    private static Path credentialsFile(Path directory, String token,
            String digest) throws IOException {
        return Files.writeString(Files.createTempFile(directory, "harness", ".env"),
                "QWEN_SERVER_TOKEN=" + token
                        + "\nQWEN_HOSTED_HARNESS_CAPABILITY_DIGEST=" + digest
                        + "\n");
    }

    // Binds the file the way startup validation does before run()'s
    // Harness row.
    private static ManagedAgentProperties fromFile(Path file, String baseUrl) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getSessionStore().setEnabled(true);
        properties.getHarness().setCredentialsFile(file.toString());
        properties.getHarness().setBaseUrl(baseUrl);
        properties.validateForPreflight();
        return properties;
    }

    private static ManagedAgentProperties harness(String baseUrl) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getHarness().setToken("token");
        properties.getHarness().setCapabilityDigest(DIGEST);
        properties.getHarness().setBaseUrl(baseUrl);
        return properties;
    }

    private static String encoded(int bytes) {
        return Base64.getEncoder().encodeToString(new byte[bytes]);
    }
}
