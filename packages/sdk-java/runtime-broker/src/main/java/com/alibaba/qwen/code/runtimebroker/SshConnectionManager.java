package com.alibaba.qwen.code.runtimebroker;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ConnectException;
import java.net.ServerSocket;
import java.net.StandardProtocolFamily;
import java.net.URI;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.channels.SocketChannel;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/** Owns SSH control sockets and ephemeral forwarding addresses, never remote workers. */
public final class SshConnectionManager implements AutoCloseable {
    private static final int RECORD_LIMIT = 64 * 1024;
    private static final Duration COMMAND_TIMEOUT = Duration.ofSeconds(60);
    private final URI publicationEndpoint;
    private final Path socketDirectory;
    private final CommandRunner runner;
    private final FileChannel ownershipChannel;
    private final FileLock ownershipLock;
    private final Map<String, Connection> connections = new ConcurrentHashMap<>();
    private final Map<List<Object>, Route> routes = new ConcurrentHashMap<>();
    private final Set<List<Object>> direct = ConcurrentHashMap.newKeySet();
    private final Map<String, Object> nodeLocks = new ConcurrentHashMap<>();
    private final Thread exitHook;
    private volatile boolean closed;

    public SshConnectionManager(URI publicationEndpoint) {
        this(publicationEndpoint, defaultDirectory(publicationEndpoint), SshConnectionManager::runCommand);
    }

    public SshConnectionManager(URI publicationEndpoint, Path controlDirectory) {
        this(publicationEndpoint, controlDirectory, SshConnectionManager::runCommand);
    }

    SshConnectionManager(URI publicationEndpoint, CommandRunner runner) {
        this(publicationEndpoint, defaultDirectory(publicationEndpoint), runner);
    }

    SshConnectionManager(URI publicationEndpoint, Path controlDirectory, CommandRunner runner) {
        if (publicationEndpoint == null || !"http".equals(publicationEndpoint.getScheme())
                || publicationEndpoint.getHost() == null || publicationEndpoint.getUserInfo() != null
                || publicationEndpoint.getRawQuery() != null || publicationEndpoint.getRawFragment() != null
                || runner == null) {
            throw new IllegalArgumentException("An HTTP publication endpoint and SSH runner are required");
        }
        this.publicationEndpoint = publicationEndpoint;
        this.runner = runner;
        try {
            socketDirectory = controlDirectory.toAbsolutePath().normalize();
            privateDirectory(socketDirectory);
            FileChannel channel = FileChannel.open(socketDirectory.resolve("controller.lock"),
                    Set.of(StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            try {
                requirePrivateFile(socketDirectory.resolve("controller.lock"));
                FileLock lock = channel.tryLock();
                if (lock == null) {
                    throw controllerBusy();
                }
                ownershipChannel = channel;
                ownershipLock = lock;
            } catch (IOException | RuntimeException failure) {
                channel.close();
                throw failure;
            }
        } catch (OverlappingFileLockException failure) {
            throw controllerBusy();
        } catch (IOException failure) {
            throw unavailable(failure);
        }
        exitHook = new Thread(this::close, "runtime-ssh-exit");
        Runtime.getRuntime().addShutdownHook(exitHook);
    }

    /** Sends credentials only through SSH stdin; command arguments contain trusted paths alone. */
    public Map<String, Object> bootstrap(SshRuntimeNode node, Map<String, Object> fields) {
        byte[] input = JsonCodec.encode(fields);
        if (input.length > RECORD_LIMIT) {
            throw new IllegalArgumentException("SSH bootstrap request exceeds its size limit");
        }
        CommandResult exchange;
        synchronized (nodeLock(node)) {
            Connection connection = connection(node);
            List<String> command = base(node, connection.socket());
            command.addAll(List.of("-o", "ControlMaster=no"));
            command.add(node.sshHost());
            command.add(quote(node.nodeExecutable()) + " " + quote(node.qwenEntry())
                    + " managed-runtime-bootstrap");
            exchange = runner.run(List.copyOf(command), input, COMMAND_TIMEOUT);
        }
        if (exchange.exitCode() != 0 || exchange.stdout().length > RECORD_LIMIT) {
            throw unavailable(null);
        }
        Map<String, Object> envelope;
        try {
            envelope = JsonCodec.parseObject(exchange.stdout(), "SSH bootstrap response");
        } catch (RuntimeException failure) {
            throw protocol();
        }
        if (!Long.valueOf(1).equals(BrokerValues.exactLong(envelope.get("protocolVersion")))) {
            throw protocol();
        }
        if (Boolean.TRUE.equals(envelope.get("ok")) && envelope.size() == 3
                && envelope.get("result") instanceof Map<?, ?> result) {
            return stringMap(result);
        }
        if (Boolean.FALSE.equals(envelope.get("ok")) && envelope.size() == 3
                && envelope.get("error") instanceof Map<?, ?> error
                && error.get("code") instanceof String code && code.matches("ssh_runtime_[a-z_]{1,80}")
                && error.get("retryable") instanceof Boolean retryable) {
            throw new RuntimeBrokerException(retryable ? 503 : 409, code,
                    "Remote Runtime operation could not be completed.", retryable);
        }
        throw protocol();
    }

    public synchronized void register(RuntimeLease lease, SshRuntimeNode node) {
        requireRemoteEndpoint(lease.getEndpoint());
        requireOpen();
        List<Object> key = leaseKey(lease);
        Route previous = routes.get(key);
        if (direct.contains(key) || previous != null && !previous.node().equals(node)) {
            throw conflict();
        }
        routes.putIfAbsent(key, new Route(node, lease.getEndpoint()));
    }

    /** Used only after the routing provisioner has selected an explicitly direct provider. */
    public synchronized void registerDirect(RuntimeLease lease) {
        requireOpen();
        if (routes.containsKey(leaseKey(lease))) {
            throw conflict();
        }
        direct.add(leaseKey(lease));
    }

    /** Returns only a transport address; the lease retains its original remote origin. */
    public URI resolveEndpoint(RuntimeLease lease) {
        requireOpen();
        Route route = routes.get(leaseKey(lease));
        if (route == null) {
            if (direct.contains(leaseKey(lease))) {
                return lease.getEndpoint();
            }
            throw conflict();
        }
        synchronized (nodeLock(route.node())) {
            Connection connection = connection(route.node());
            URI forwarded = connection.forwards().get(route.endpoint());
            if (forwarded != null) {
                return forwarded;
            }
            for (int attempt = 0; attempt < 3; attempt++) {
                int port = availablePort();
                List<String> command = control(route.node(), connection.socket(), "forward");
                command.add("-L");
                command.add("127.0.0.1:" + port + ":127.0.0.1:" + route.endpoint().getPort());
                command.add(route.node().sshHost());
                CommandResult result = runner.run(List.copyOf(command), new byte[0], COMMAND_TIMEOUT);
                if (result.exitCode() == 0) {
                    URI endpoint = URI.create("http://127.0.0.1:" + port);
                    connection.forwards().put(route.endpoint(), endpoint);
                    return endpoint;
                }
            }
            throw unavailable(null);
        }
    }

    public URI publicationEndpoint(SshRuntimeNode node) {
        return URI.create("http://127.0.0.1:" + node.publicationPort()
                + (publicationEndpoint.getRawPath() == null ? "" : publicationEndpoint.getRawPath()));
    }

    public synchronized void forget(RuntimeLease lease) {
        routes.remove(leaseKey(lease));
    }

    private Connection connection(SshRuntimeNode node) {
        requireOpen();
        Connection old = connections.get(node.nodeId());
        if (old != null && !old.node().equals(node)) {
            throw conflict();
        }
        Path socket = socketDirectory.resolve("n" + identity(node.nodeId()));
        verifyConfiguration(node, socket);
        if (old != null || Files.exists(socket, LinkOption.NOFOLLOW_LINKS)) {
            requirePrivateSocket(socket);
            List<String> check = control(node, socket, "check");
            check.add(node.sshHost());
            if (runner.run(List.copyOf(check), new byte[0], COMMAND_TIMEOUT).exitCode() == 0) {
                return old == null ? rememberConnection(new Connection(node, socket, new HashMap<>())) : old;
            }
            removeUnreachableSocket(socket);
        }
        List<String> command = base(node, socket);
        command.addAll(List.of("-o", "ControlMaster=yes", "-o", "ControlPersist=no", "-o",
                "ExitOnForwardFailure=yes", "-f", "-N", "-R", "127.0.0.1:" + node.publicationPort()
                        + ":" + publicationEndpoint.getHost() + ":" + publicationPort(), node.sshHost()));
        if (runner.run(List.copyOf(command), new byte[0], COMMAND_TIMEOUT).exitCode() != 0) {
            throw unavailable(null);
        }
        return rememberConnection(new Connection(node, socket, new HashMap<>()));
    }

    private Connection rememberConnection(Connection created) {
        synchronized (this) {
            if (!closed) {
                connections.put(created.node().nodeId(), created);
                return created;
            }
        }
        closeConnection(created);
        throw unavailable(null);
    }

    private void verifyConfiguration(SshRuntimeNode node, Path socket) {
        Path registration = socket.resolveSibling(socket.getFileName() + ".json");
        Map<String, Object> expected = Map.of("version", 1, "nodeId", node.nodeId(), "sshHost", node.sshHost(),
                "nodeExecutable", node.nodeExecutable(), "qwenEntry", node.qwenEntry(),
                "stateDirectory", node.stateDirectory(), "allowedRoots", node.allowedRoots(),
                "publicationEndpoint", publicationEndpoint.toString(), "publicationPort", node.publicationPort());
        try {
            if (Files.notExists(registration, LinkOption.NOFOLLOW_LINKS)) {
                if (Files.exists(socket, LinkOption.NOFOLLOW_LINKS)) {
                    throw conflict();
                }
                try (FileChannel file = FileChannel.open(registration,
                        Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
                        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))) {
                    ByteBuffer bytes = ByteBuffer.wrap(JsonCodec.encode(expected));
                    while (bytes.hasRemaining()) {
                        file.write(bytes);
                    }
                    file.force(true);
                }
            }
            requirePrivateFile(registration);
            if (Files.size(registration) > RECORD_LIMIT || !BrokerValues.sameJsonMap(expected,
                    JsonCodec.parseObject(Files.readAllBytes(registration), "SSH control registration"))) {
                throw conflict();
            }
        } catch (IOException failure) {
            throw unavailable(failure);
        }
    }

    private static Path defaultDirectory(URI publicationEndpoint) {
        Path directory = Path.of("/tmp", "qwen-ssh-" + identity(System.getProperty("user.name")));
        try {
            privateDirectory(directory);
        } catch (IOException failure) {
            throw unavailable(failure);
        }
        return directory.resolve("c" + identity(String.valueOf(publicationEndpoint)));
    }

    private static String identity(String value) {
        return UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8)).toString().replace("-", "").substring(0, 16);
    }

    private static void privateDirectory(Path directory) throws IOException {
        Files.createDirectories(directory,
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
            throw conflict();
        }
        requirePrivateFile(directory);
    }

    private static void requirePrivateFile(Path path) throws IOException {
        if (Files.isSymbolicLink(path) || !Files.getOwner(path, LinkOption.NOFOLLOW_LINKS).equals(path.getFileSystem()
                .getUserPrincipalLookupService().lookupPrincipalByName(System.getProperty("user.name")))
                || Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS).stream()
                        .anyMatch(permission -> permission.name().startsWith("GROUP_") || permission.name().startsWith("OTHERS_"))) {
            throw conflict();
        }
    }

    private static void requirePrivateSocket(Path socket) {
        try {
            if (Files.exists(socket, LinkOption.NOFOLLOW_LINKS)) {
                requirePrivateFile(socket);
            }
        } catch (IOException failure) {
            throw unavailable(failure);
        }
    }

    private static void removeUnreachableSocket(Path socket) {
        try {
            if (Files.notExists(socket, LinkOption.NOFOLLOW_LINKS)) {
                return;
            }
            try (SocketChannel probe = SocketChannel.open(StandardProtocolFamily.UNIX)) {
                probe.configureBlocking(false);
                probe.connect(UnixDomainSocketAddress.of(socket));
                throw unavailable(null);
            } catch (ConnectException | NoSuchFileException absent) {
                Files.deleteIfExists(socket);
            }
        } catch (IOException failure) {
            throw unavailable(failure);
        }
    }

    private Object nodeLock(SshRuntimeNode node) {
        return nodeLocks.computeIfAbsent(node.nodeId(), ignored -> new Object());
    }

    private int publicationPort() {
        return publicationEndpoint.getPort() < 0 ? 80 : publicationEndpoint.getPort();
    }

    private static List<String> base(SshRuntimeNode node, Path socket) {
        return new ArrayList<>(List.of("ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
                "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no",
                "-S", socket.toString()));
    }

    private static List<String> control(SshRuntimeNode node, Path socket, String operation) {
        List<String> command = base(node, socket);
        command.addAll(List.of("-O", operation));
        return command;
    }

    private static List<Object> leaseKey(RuntimeLease lease) {
        return List.of(lease.getRuntimeInstanceId(), lease.getEndpoint(), lease.getToken(),
                lease.getLeaseId(), lease.getEpoch());
    }

    private static void requireRemoteEndpoint(URI endpoint) {
        if (!"http".equals(endpoint.getScheme()) || !"127.0.0.1".equals(endpoint.getHost())
                || endpoint.getPort() < 1 || endpoint.getPort() > 65535
                || !("".equals(endpoint.getPath()) || "/".equals(endpoint.getPath()))) {
            throw conflict();
        }
    }

    private static int availablePort() {
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            return socket.getLocalPort();
        } catch (IOException failure) {
            throw unavailable(failure);
        }
    }

    private static String quote(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }

    private static Map<String, Object> stringMap(Map<?, ?> raw) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (var entry : raw.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw protocol();
            }
            result.put(key, entry.getValue());
        }
        return BrokerValues.immutableMap(result);
    }

    private void requireOpen() {
        if (closed) {
            throw unavailable(null);
        }
    }

    @Override
    public void close() {
        List<Connection> snapshot;
        List<Object> pending;
        synchronized (this) {
            if (closed) {
                return;
            }
            closed = true;
            pending = List.copyOf(nodeLocks.values());
        }
        for (Object lock : pending) {
            synchronized (lock) {
                // A late launch must finish cleanup before the controller lock changes owner.
            }
        }
        synchronized (this) {
            snapshot = List.copyOf(connections.values());
            routes.clear();
            direct.clear();
            connections.clear();
        }
        for (Connection connection : snapshot) {
            closeConnection(connection);
        }
        try (ownershipChannel) {
            ownershipLock.release();
        } catch (IOException ignored) {
        }
        if (Thread.currentThread() != exitHook) {
            try {
                Runtime.getRuntime().removeShutdownHook(exitHook);
            } catch (IllegalStateException ignored) {
            }
        }
    }

    private void closeConnection(Connection connection) {
        try {
            List<String> command = control(connection.node(), connection.socket(), "exit");
            command.add(connection.node().sshHost());
            runner.run(List.copyOf(command), new byte[0], Duration.ofSeconds(5));
        } catch (RuntimeException ignored) {
            // Closing a control socket cannot establish remote worker stop proof.
        }
    }

    static CommandResult runCommand(List<String> command, byte[] input, Duration timeout) {
        Process process = null;
        try {
            ProcessBuilder builder = new ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.DISCARD);
            if (input.length == 0) {
                builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            }
            process = builder.start();
            Process started = process;
            CompletableFuture<byte[]> output = input.length == 0 ? CompletableFuture.completedFuture(new byte[0])
                    : CompletableFuture.supplyAsync(() -> {
                        try {
                            return started.getInputStream().readNBytes(RECORD_LIMIT + 1);
                        } catch (IOException failure) {
                            throw unavailable(failure);
                        }
                    });
            try (var stdin = process.getOutputStream()) {
                stdin.write(input);
            }
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                throw unavailable(null);
            }
            return new CommandResult(process.exitValue(), output.get(1, TimeUnit.SECONDS));
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            throw unavailable(failure);
        } catch (Exception failure) {
            throw unavailable(failure);
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    private static RuntimeBrokerException unavailable(Throwable failure) {
        return new RuntimeBrokerException(503, "ssh_runtime_unavailable", "SSH Runtime connection is unavailable.",
                true, failure);
    }

    private static RuntimeBrokerException protocol() {
        return new RuntimeBrokerException(502, "ssh_runtime_protocol_invalid", "SSH bootstrap response is invalid.", false);
    }

    private static RuntimeBrokerException conflict() {
        return new RuntimeBrokerException(409, "ssh_runtime_identity_conflict", "SSH Runtime identity conflicts.", false);
    }

    private static RuntimeBrokerException controllerBusy() {
        return new RuntimeBrokerException(503, "ssh_runtime_controller_busy", "SSH control state is owned by another Broker.", true);
    }

    @FunctionalInterface
    interface CommandRunner {
        CommandResult run(List<String> command, byte[] input, Duration timeout);
    }

    record CommandResult(int exitCode, byte[] stdout) {
    }

    private record Connection(SshRuntimeNode node, Path socket, Map<URI, URI> forwards) {
    }

    private record Route(SshRuntimeNode node, URI endpoint) {
    }
}
