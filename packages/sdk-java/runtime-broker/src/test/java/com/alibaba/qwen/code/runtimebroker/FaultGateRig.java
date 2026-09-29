package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.h2.tools.Server;

/**
 * The multi-process rig behind the Stage F fault gates (FG1). A gate starts
 * real Broker JVMs ({@link FaultGateBroker}) that provision the real bundled
 * worker ({@code node dist/cli.js managed-runtime-worker}), puts a
 * {@link FaultProxy} between each Broker and its workers, and keeps every
 * record in a file-backed H2 database behind a TCP server, so a restarted or
 * second Broker sees the same rows. The gate reads those rows directly.
 * Missing prerequisites fail the gate; nothing is skipped.
 */
final class FaultGateRig implements AutoCloseable {
    static final String CLI_PROPERTY = "qwen.cli.entry";
    static final String HARNESS = "harness-1";
    static final String SESSION = "runtime-session-1";
    static final String STORAGE = "storage-a";
    static final Duration OPERATION_LEASE = Duration.ofSeconds(2);
    static final Duration DISPATCH_LEASE = Duration.ofSeconds(2);
    static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(10);
    static final Duration WAIT = Duration.ofSeconds(45);
    private static final String SECRET_KEY = Base64.getEncoder()
            .encodeToString("fault-gate-secret-key-0123456789"
                    .getBytes(StandardCharsets.US_ASCII));

    enum Provisioner {
        /** The production provisioner alone: owns workers in memory. */
        LOCAL_PROCESS,
        /** Production durable store; test host identity is injected only on non-Linux hosts. */
        DURABLE_LOCAL_PROCESS,
        TRUSTED_LOCAL_PROCESS,
        /** The production provisioner plus a pid record a restart adopts. */
        RECOVERABLE
    }

    enum Placement {
        /** Boot v1 and attestation v2: the tool path of FG1-FG4. */
        LEGACY,
        /**
         * managed-context/1 (W0c): boot v2 and attestation v3 for the
         * Workspace execution profile, and a Session context that acquire
         * installs and activates before any tool runs.
         */
        MANAGED
    }

    final Path root;
    final Path workspace;
    final Placement placement;
    /** Where the Session's tools run: the Workspace, or its context. */
    final Path directory;
    final RuntimeScope scope;
    /** The Session context a MANAGED acquire installs; null for LEGACY. */
    final ContextBinding context;
    final JdbcToolExecutionRepository executions;
    final JdbcRuntimeBindingRepository bindings;
    private final Path cli;
    private final Server database;
    private final DataSource dataSource;
    private final List<AutoCloseable> resources = new ArrayList<>();
    private final List<BrokerProcess> brokers = new ArrayList<>();
    private final Set<ProcessHandle> orphans = new HashSet<>();

    private FaultGateRig(Path cli, Placement placement) throws Exception {
        this.cli = cli;
        this.placement = placement;
        root = Files.createTempDirectory("runtime-broker-fault-gate")
                .toRealPath();
        workspace = Files.createDirectories(root.resolve("workspace"));
        Files.createDirectories(root.resolve("records"));
        Files.createDirectories(root.resolve("home"));
        database = Server.createTcpServer("-tcpPort", "0", "-ifNotExists",
                "-baseDir", root.resolve("db").toString()).start();
        dataSource = new DriverManagerDataSource(
                jdbcUrl(database.getPort()), "sa", "");
        JdbcRuntimeBrokerSchema.initialize(dataSource);
        executions = new JdbcToolExecutionRepository(dataSource);
        bindings = new JdbcRuntimeBindingRepository(dataSource,
                AesGcmSecretProtector.fromBase64("fault-gate", SECRET_KEY));
        if (placement == Placement.MANAGED) {
            // The Workspace is the mount root; the context names a child.
            directory = Files.createDirectories(workspace.resolve("project"));
            scope = new RuntimeScope("tenant-a", "workspace-a", "1",
                    workspace.toString(),
                    WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
            context = new ContextBinding("tenant-a", "workspace-a", 1,
                    STORAGE, "project",
                    WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        } else {
            directory = workspace;
            scope = new RuntimeScope("tenant-a", "workspace-a", "1",
                    workspace.toString(), "sha256:" + "a".repeat(64),
                    "workspace");
            context = null;
        }
    }

    static FaultGateRig open() throws Exception {
        return open(Placement.LEGACY);
    }

    static FaultGateRig open(Placement placement) throws Exception {
        if (System.getProperty("os.name").toLowerCase(Locale.ROOT)
                .startsWith("windows")) {
            throw new AssertionError(
                    "the fault gates need POSIX signals and process trees");
        }
        String configured = System.getProperty(CLI_PROPERTY);
        if (configured == null || configured.isBlank()) {
            throw new AssertionError("-D" + CLI_PROPERTY
                    + " must name the bundled dist/cli.js");
        }
        Path cli = Path.of(configured).toAbsolutePath().normalize();
        if (!Files.isRegularFile(cli)) {
            throw new AssertionError(cli + " is missing; run `npm run build"
                    + " && npm run bundle` at the repository root first");
        }
        Process node;
        try {
            node = new ProcessBuilder("node", "--version")
                    .redirectErrorStream(true).start();
        } catch (IOException missing) {
            throw new AssertionError("node is required on PATH", missing);
        }
        if (!node.waitFor(30, TimeUnit.SECONDS) || node.exitValue() != 0) {
            throw new AssertionError("node --version failed");
        }
        return new FaultGateRig(cli, placement);
    }

    FaultProxy proxy() throws IOException {
        FaultProxy proxy = new FaultProxy();
        resources.add(proxy);
        return proxy;
    }

    /** A relay a gate can cut to take the database away from a Broker. */
    TcpRelay databaseRelay() throws IOException {
        TcpRelay relay = new TcpRelay(database.getPort());
        resources.add(relay);
        return relay;
    }

    BrokerProcess broker(String name, FaultProxy proxy,
            Provisioner provisioner) throws Exception {
        return broker(name, proxy, provisioner, null);
    }

    BrokerProcess broker(String name, FaultProxy proxy,
            Provisioner provisioner, TcpRelay relay) throws Exception {
        return broker(name, proxy, provisioner, relay, REQUEST_TIMEOUT);
    }

    BrokerProcess broker(String name, FaultProxy proxy,
            Provisioner provisioner, TcpRelay relay, Duration requestTimeout)
            throws Exception {
        Map<String, Object> scopeConfig = new LinkedHashMap<>();
        scopeConfig.put("tenantId", scope.getTenantId());
        scopeConfig.put("workspaceId", scope.getWorkspaceId());
        scopeConfig.put("workspaceGeneration",
                scope.getWorkspaceGeneration());
        scopeConfig.put("canonicalCwd", scope.getCanonicalCwd());
        scopeConfig.put("capabilityDigest", scope.getCapabilityDigest());
        scopeConfig.put("isolationClass", scope.getIsolationClass());
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("jdbcUrl", jdbcUrl(relay == null ? database.getPort()
                : relay.port()));
        config.put("secretKey", SECRET_KEY);
        config.put("ownerId", name + "-" + UUID.randomUUID());
        config.put("node", "node");
        config.put("cli", cli.toString());
        config.put("stateDir", root.toString());
        config.put("durable", provisioner == Provisioner.DURABLE_LOCAL_PROCESS
                || provisioner == Provisioner.TRUSTED_LOCAL_PROCESS);
        config.put("trustedReboot", provisioner == Provisioner.TRUSTED_LOCAL_PROCESS);
        config.put("records", provisioner == Provisioner.RECOVERABLE
                ? root.resolve("records").toString() : null);
        config.put("proxyPort", proxy.port());
        config.put("operationLeaseMillis", OPERATION_LEASE.toMillis());
        config.put("dispatchLeaseMillis", DISPATCH_LEASE.toMillis());
        config.put("requestTimeoutMillis", requestTimeout.toMillis());
        config.put("scope", scopeConfig);
        if (context != null) {
            Map<String, Object> contextConfig = new LinkedHashMap<>();
            contextConfig.put("storageId", context.getStorageId());
            contextConfig.put("cwdRelative", context.getCwdRelative());
            contextConfig.put("contextRevision",
                    context.getContextRevision());
            config.put("context", contextConfig);
        }
        String file = name + "-" + brokers.size();
        Path configFile = root.resolve(file + ".json");
        Files.writeString(configFile, JSON.toJSONString(config));
        BrokerProcess broker = BrokerProcess.start(name, configFile,
                root.resolve(file + ".log"), root.resolve("home"));
        brokers.add(broker);
        return broker;
    }

    /** SIGKILLs a Broker JVM alone and keeps its orphaned workers in view. */
    void killBroker(BrokerProcess broker) throws InterruptedException {
        orphans.addAll(broker.descendants());
        broker.kill();
    }

    void closeBroker(BrokerProcess broker) throws InterruptedException {
        orphans.addAll(broker.descendants());
        broker.close();
    }

    /** SIGKILLs a Broker's worker together with the tool processes below. */
    void killWorker(BrokerProcess broker) {
        List<ProcessHandle> workers = broker.workers();
        if (workers.size() != 1) {
            throw new AssertionError("expected one worker, found " + workers);
        }
        ProcessTrees.kill(workers.get(0), WAIT);
    }

    /** A foreground shell call whose side effects land in the workspace. */
    static Map<String, Object> shell(String callId, String command) {
        return shell(SESSION, callId, command);
    }

    /** A foreground shell call of another Runtime Session. */
    static Map<String, Object> shell(String session, String callId,
            String command) {
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("command", command);
        input.put("is_background", false);
        Map<String, Object> reference = new LinkedHashMap<>();
        reference.put("sessionId", session);
        reference.put("promptId", "prompt-1");
        reference.put("callId", callId);
        reference.put("argsDigest", "digest-" + callId);
        reference.put("toolName", "run_shell_command");
        reference.put("input", input);
        return reference;
    }

    /** The lines a tool appended to a marker file in the workspace. */
    List<String> marker(String name) {
        return lines(workspace.resolve(name));
    }

    /**
     * A command that appends its own working directory to a file outside
     * every Workspace, so a gate sees whether, and where, a tool ran.
     */
    String recordRun() {
        return "pwd >> '" + root.resolve("runs") + "'";
    }

    /** The working directory of every tool run {@link #recordRun} saw. */
    List<String> runs() {
        return lines(root.resolve("runs"));
    }

    private static List<String> lines(Path file) {
        try {
            return Files.readAllLines(file);
        } catch (NoSuchFileException missing) {
            return List.of();
        } catch (IOException exception) {
            throw new UncheckedIOException(exception);
        }
    }

    ToolExecutionRecord execution(String executionCallId) {
        return executions.findByExecutionCallId(executionCallId);
    }

    ToolExecutionRecord awaitExecution(String executionCallId,
            Predicate<ToolExecutionRecord> condition, String what)
            throws InterruptedException {
        try {
            return await(() -> execution(executionCallId), condition, what);
        } catch (AssertionError timeout) {
            ToolExecutionRecord last = execution(executionCallId);
            throw new AssertionError("timed out waiting for " + what
                    + "; the execution is " + (last == null ? "missing"
                            : last.getState() + " " + last.getExecutionStatus()
                                    + ", dispatch " + last.getDispatchOwner()
                                    + "/" + last.getDispatchGeneration())
                    + logs(), timeout);
        }
    }

    void awaitMarker(String name, List<String> expected)
            throws InterruptedException {
        await(() -> marker(name), expected::equals, name + " = " + expected);
    }

    /** Proves no further side effect reaches a marker for a while. */
    void holdMarker(String name, List<String> expected, Duration period)
            throws InterruptedException {
        hold(() -> marker(name), expected::equals, period, name);
    }

    /** Waits until the database clock has passed the dispatch lease. */
    void awaitDispatchLapse(String executionCallId)
            throws InterruptedException {
        await(() -> execution(executionCallId), record -> record
                .getDispatchLeaseUntil() == null
                || databaseNow().isAfter(record.getDispatchLeaseUntil()),
                "dispatch lease of " + executionCallId + " lapsed");
    }

    Instant databaseNow() {
        try (Connection connection = dataSource.getConnection()) {
            return JdbcRepositorySupport.databaseNow(connection);
        } catch (SQLException exception) {
            throw new IllegalStateException(exception);
        }
    }

    RuntimeBindingRecord activeBinding() {
        return bindings.findActive(placement == Placement.MANAGED
                ? new RuntimeProvisionRequest(scope, HARNESS,
                        LocalProcessRuntimeProvisioner.KIND, STORAGE)
                : new RuntimeProvisionRequest(scope, null,
                        LocalProcessRuntimeProvisioner.KIND));
    }

    RuntimeSession session() {
        return new RuntimeSession(HARNESS, SESSION, "bootstrap", scope);
    }

    static <T> T await(Supplier<T> probe, Predicate<T> done, String what)
            throws InterruptedException {
        long deadline = System.nanoTime() + WAIT.toNanos();
        T value = probe.get();
        while (!done.test(value)) {
            if (System.nanoTime() > deadline) {
                throw new AssertionError("timed out waiting for " + what
                        + "; last value: " + value);
            }
            Thread.sleep(50);
            value = probe.get();
        }
        return value;
    }

    /** Waits until a value has stopped changing for a quiet period. */
    static <T> T settle(Supplier<T> probe, Duration quiet, String what)
            throws InterruptedException {
        long deadline = System.nanoTime() + WAIT.toNanos();
        T value = probe.get();
        long since = System.nanoTime();
        while (System.nanoTime() - since < quiet.toNanos()) {
            if (System.nanoTime() > deadline) {
                throw new AssertionError(what + " kept changing; last value: "
                        + value);
            }
            Thread.sleep(50);
            T next = probe.get();
            if (!next.equals(value)) {
                value = next;
                since = System.nanoTime();
            }
        }
        return value;
    }

    /** Proves a condition still holds after a quiet period. */
    static <T> void hold(Supplier<T> probe, Predicate<T> invariant,
            Duration period, String what) throws InterruptedException {
        long deadline = System.nanoTime() + period.toNanos();
        do {
            T value = probe.get();
            if (!invariant.test(value)) {
                throw new AssertionError(what + " broke: " + value);
            }
            Thread.sleep(50);
        } while (System.nanoTime() < deadline);
    }

    String logs() {
        StringBuilder text = new StringBuilder();
        for (BrokerProcess broker : brokers) {
            text.append("\n--- broker ").append(broker.pid()).append(" ---\n")
                    .append(broker.logTail());
        }
        return text.toString();
    }

    @Override
    public void close() throws Exception {
        for (BrokerProcess broker : brokers) {
            orphans.addAll(broker.descendants());
            broker.close();
        }
        // Workers outlive a killed Broker; kill them even when a Broker's
        // graceful close already stopped the ones it owned.
        ProcessTrees.kill(orphans, WAIT);
        for (AutoCloseable resource : resources) {
            resource.close();
        }
        database.stop();
        try (var paths = Files.walk(root)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                    // Best-effort cleanup of the rig directory.
                }
            });
        }
    }

    private static String jdbcUrl(int port) {
        return "jdbc:h2:tcp://127.0.0.1:" + port
                + "/broker;MODE=MySQL;DATABASE_TO_LOWER=TRUE";
    }
}
