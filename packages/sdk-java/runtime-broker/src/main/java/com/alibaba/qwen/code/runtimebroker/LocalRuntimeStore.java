package com.alibaba.qwen.code.runtimebroker;

import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;

/** Private local-disk authority; its records never contain worker credentials. */
final class LocalRuntimeStore {
    private static final int RECORD_LIMIT = 64 * 1024;
    private static final Map<Path, ReentrantLock> LOCKS = new ConcurrentHashMap<>();
    private final Path directory;
    private final UserPrincipal owner;
    private final HostIdentity identity;

    record HostIdentity(String hostId, String bootId, String pidNamespace, String timeNamespace) {
        HostIdentity {
            if (hostId == null || !hostId.matches("[0-9a-f]{32}")
                    || bootId == null || !bootId.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
                    || pidNamespace == null || !pidNamespace.matches("pid:\\[[0-9]+\\]")
                    || timeNamespace == null || !timeNamespace.matches("time:\\[[0-9]+\\]")) {
                throw new IllegalArgumentException("Linux host/boot identity is invalid");
            }
        }

        static HostIdentity linux() {
            try {
                return new HostIdentity(Files.readString(Path.of("/etc/machine-id")).strip(),
                        Files.readString(Path.of("/proc/sys/kernel/random/boot_id")).strip(),
                        Files.readSymbolicLink(Path.of("/proc/self/ns/pid")).toString(),
                        Files.readSymbolicLink(Path.of("/proc/self/ns/time")).toString());
            } catch (IOException | IllegalArgumentException error) {
                if (!"Linux".equals(System.getProperty("os.name"))) {
                    throw new IllegalStateException("Durable local-process mode requires Linux"
                            + " (os.name='" + System.getProperty("os.name") + "'); opt out with"
                            + " runtime-broker.durable-local-process=false and"
                            + " runtime-broker.trusted-local-reboot-recovery=false.", error);
                }
                throw identityUnavailable(error);
            }
        }

        /** Malformed or unreadable identity fails closed into one operator-facing error. */
        static IllegalStateException identityUnavailable(Throwable cause) {
            return new IllegalStateException("Trusted Linux host/boot identity is unavailable"
                    + " (/etc/machine-id, /proc/sys/kernel/random/boot_id,"
                    + " /proc/self/ns/pid, /proc/self/ns/time); durable local-process mode requires it."
                    + " Opt out with runtime-broker.durable-local-process=false and"
                    + " runtime-broker.trusted-local-reboot-recovery=false.", cause);
        }
    }

    enum State { INTENT, LAUNCHING, REGISTERED, READY, RETIRED }

    record Registration(RuntimeResourceHandle handle, State state, long pid, String started, URI endpoint) {
        Registration {
            if (handle == null || !supported(handle) || state == null
                    || pid < 0 || (pid == 0) != (started == null)
                    || ((state == State.REGISTERED || state == State.READY) && pid == 0)
                    || ((state == State.INTENT || state == State.LAUNCHING) && pid != 0)
                    || (state == State.READY && endpoint == null)) {
                throw new IllegalArgumentException("Invalid local worker registration");
            }
            if (started != null) {
                if ("Linux".equals(System.getProperty("os.name"))) {
                    if (!started.matches("ticks:[0-9]+")) {
                        throw new IllegalArgumentException("Invalid Linux process start identity");
                    }
                    Long.parseLong(started.substring(6));
                } else {
                    if (!started.startsWith("instant:")) {
                        throw new IllegalArgumentException("Invalid test process start identity");
                    }
                    Instant.parse(started.substring(8));
                }
            }
            if (endpoint != null && (!"http".equals(endpoint.getScheme())
                    || !"127.0.0.1".equals(endpoint.getHost())
                    || !BrokerValues.requireOrigin(endpoint, "endpoint").equals(endpoint))) {
                throw new IllegalArgumentException("Invalid local worker endpoint");
            }
        }

        Registration withState(State next) {
            return new Registration(handle, next, pid, started, endpoint);
        }

        ProcessHandle process() {
            if (pid == 0) {
                return null;
            }
            return ProcessHandle.of(pid).filter(process -> process.isAlive()
                    && started.equals(startIdentity(process))).orElse(null);
        }

        boolean processAbsent() {
            if (pid == 0) {
                return false;
            }
            if ("Linux".equals(System.getProperty("os.name"))) {
                return linuxProcessAbsent(Path.of("/proc", Long.toString(pid), "stat"), started);
            }
            ProcessHandle process = ProcessHandle.of(pid).orElse(null);
            String observed = process == null ? null : startIdentity(process);
            return process == null || !process.isAlive()
                    || observed != null && !observed.equals(started);
        }
    }

    static boolean linuxProcessAbsent(Path stat, String expected) {
        try {
            String text = Files.readString(stat);
            if (!expected.equals(linuxStartIdentity(text))) {
                return true;
            }
            char state = text.substring(text.lastIndexOf(')') + 1).strip().charAt(0);
            return state == 'Z' || state == 'X' || state == 'x';
        } catch (java.nio.file.NoSuchFileException absent) {
            return true;
        } catch (IOException | IllegalArgumentException uncertain) {
            return false;
        }
    }

    static String startIdentity(ProcessHandle process) {
        if (!"Linux".equals(System.getProperty("os.name"))) {
            return process.info().startInstant().map(value -> "instant:" + value).orElse(null);
        }
        try {
            return linuxStartIdentity(Files.readString(Path.of("/proc", Long.toString(process.pid()), "stat")));
        } catch (IOException | IllegalArgumentException error) {
            return null;
        }
    }

    static String linuxStartIdentity(String stat) {
        int end = stat.lastIndexOf(')');
        String[] fields = end < 0 ? new String[0] : stat.substring(end + 1).strip().split("\\s+");
        if (fields.length < 20 || !fields[19].matches("[0-9]+")) {
            throw new IllegalArgumentException("Invalid Linux process start identity");
        }
        return "ticks:" + Long.parseLong(fields[19]);
    }

    LocalRuntimeStore(Path directory, HostIdentity identity) {
        try {
            this.directory = directory.toAbsolutePath().normalize();
            this.identity = Objects.requireNonNull(identity);
            this.owner = processOwner();
            Path current = this.directory;
            while (current != null) {
                if (Files.isSymbolicLink(current)) {
                    throw new IOException("Recovery path contains a symlink");
                }
                current = current.getParent();
            }
            if (!Files.exists(this.directory, LinkOption.NOFOLLOW_LINKS)) {
                try {
                    Files.createDirectory(this.directory, PosixFilePermissions.asFileAttribute(
                            PosixFilePermissions.fromString("rwx------")));
                    syncDirectory(this.directory.getParent());
                } catch (java.nio.file.FileAlreadyExistsException ignored) {
                    // A second Broker initialized the directory; validate it below.
                }
            }
            validate(this.directory, true);
        } catch (IOException error) {
            throw new IllegalStateException("Private local Runtime state directory is unavailable"
                    + " at " + directory.toAbsolutePath().normalize()
                    + "; durable local-process mode requires an owner-private 0700 state directory."
                    + " Opt out with runtime-broker.durable-local-process=false and"
                    + " runtime-broker.trusted-local-reboot-recovery=false.", error);
        }
    }

    /** UID-resolved owner, so a numeric UID without a passwd entry never gates startup. */
    private static UserPrincipal processOwner() throws IOException {
        Path self = Path.of("/proc/self");
        if (Files.exists(self)) {
            return Files.getOwner(self);
        }
        Path probe = Files.createTempFile("owner-probe-", ".tmp");
        try {
            return Files.getOwner(probe);
        } finally {
            Files.deleteIfExists(probe);
        }
    }

    static boolean supported(RuntimeResourceHandle handle) {
        return handle != null && LocalProcessRuntimeProvisioner.KIND.equals(handle.getKind())
                && handle.getVersion() == 2;
    }

    <T> T locked(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle known, boolean create, Operation<T> operation) {
        String key = digest(seed.getProvisionRequestId().getBytes(StandardCharsets.UTF_8));
        Path lockPath = directory.resolve(key + ".lock");
        ReentrantLock local = LOCKS.computeIfAbsent(lockPath, ignored -> new ReentrantLock());
        if (!local.tryLock()) {
            throw busy();
        }
        try {
            validate(directory, true);
            boolean createdLock = false;
            if (!Files.exists(lockPath, LinkOption.NOFOLLOW_LINKS)) {
                if (!create || known != null || Files.exists(directory.resolve(key + ".json"),
                        LinkOption.NOFOLLOW_LINKS)) {
                    throw blocked();
                }
                try {
                    Files.createFile(lockPath, PosixFilePermissions.asFileAttribute(
                            PosixFilePermissions.fromString("rw-------")));
                    syncDirectory(directory);
                    createdLock = true;
                } catch (java.nio.file.FileAlreadyExistsException ignored) {
                    // Another Broker created the permanent lock inode.
                }
            }
            validate(lockPath, false);
            try (FileChannel channel = FileChannel.open(lockPath, StandardOpenOption.WRITE,
                    LinkOption.NOFOLLOW_LINKS); FileLock lock = channel.tryLock()) {
                if (lock == null) {
                    throw busy();
                }
                Resource resource = new Resource(key);
                Registration registration = resource.read();
                if (registration == null) {
                    if (!create || known != null || !createdLock) {
                        throw blocked();
                    }
                    registration = new Registration(handle(request, seed, key, identity),
                            State.INTENT, 0, null, null);
                    resource.save(registration);
                }
                RuntimeResourceHandle expected = handle(request, seed, key,
                        new HostIdentity((String) registration.handle().getValue().get("hostId"),
                                (String) registration.handle().getValue().get("bootId"),
                                (String) registration.handle().getValue().get("pidNamespace"),
                                (String) registration.handle().getValue().get("timeNamespace")));
                if (!registration.handle().equals(expected)
                        || known != null && !known.equals(registration.handle())) {
                    throw blocked();
                }
                return operation.run(resource, registration);
            }
        } catch (IOException | IllegalArgumentException error) {
            throw new RuntimeBrokerException(409, "runtime_broker_recovery_blocked",
                    "Local Runtime identity cannot be verified.", false, error);
        } finally {
            local.unlock();
        }
    }

    boolean rebooted(Registration registration) {
        return identity.hostId().equals(registration.handle().getValue().get("hostId"))
                && !identity.bootId().equals(registration.handle().getValue().get("bootId"));
    }

    boolean sameBoot(Registration registration) {
        return identity.hostId().equals(registration.handle().getValue().get("hostId"))
                && identity.bootId().equals(registration.handle().getValue().get("bootId"))
                && identity.pidNamespace().equals(registration.handle().getValue().get("pidNamespace"))
                && identity.timeNamespace().equals(registration.handle().getValue().get("timeNamespace"));
    }

    @FunctionalInterface
    interface Operation<T> {
        T run(Resource resource, Registration registration) throws IOException;
    }

    final class Resource {
        private final Path record;
        private final Path ready;

        private Resource(String key) {
            record = directory.resolve(key + ".json");
            ready = directory.resolve(key + ".ready");
        }

        Path createReady() throws IOException {
            Files.createFile(ready, PosixFilePermissions.asFileAttribute(
                    PosixFilePermissions.fromString("rw-------")));
            syncDirectory(directory);
            return ready;
        }

        byte[] readReady() throws IOException {
            validate(ready, false);
            byte[] bytes = readBounded(ready);
            for (int i = 0; i < bytes.length; i++) {
                if (bytes[i] == '\n') {
                    return java.util.Arrays.copyOf(bytes, i);
                }
            }
            return null;
        }

        private Registration read() throws IOException {
            if (!Files.exists(record, LinkOption.NOFOLLOW_LINKS)) {
                return null;
            }
            validate(record, false);
            try {
                Map<String, Object> value = JsonCodec.parseObject(readBounded(record), "local Runtime registration");
                if (!value.keySet().equals(java.util.Set.of("version", "handle", "state", "pid", "started", "endpoint"))
                        || !Objects.equals(value.get("version"), 1)) {
                    throw blocked();
                }
                return new Registration(RuntimeResourceHandle.fromJson(LocalProcessRuntimeProvisioner.KIND, 2,
                        (String) value.get("handle")), State.valueOf((String) value.get("state")),
                        ((Number) value.get("pid")).longValue(),
                        "".equals(value.get("started")) ? null : (String) value.get("started"),
                        "".equals(value.get("endpoint")) ? null : URI.create((String) value.get("endpoint")));
            } catch (RuntimeException error) {
                throw blocked();
            }
        }

        void save(Registration registration) throws IOException {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("version", 1);
            value.put("handle", registration.handle().toJson());
            value.put("state", registration.state().name());
            value.put("pid", registration.pid());
            value.put("started", registration.started() == null ? "" : registration.started());
            value.put("endpoint", registration.endpoint() == null ? "" : registration.endpoint().toString());
            Path temporary = Files.createTempFile(directory, "registration-", ".tmp",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            try {
                try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.WRITE,
                        LinkOption.NOFOLLOW_LINKS)) {
                    ByteBuffer bytes = ByteBuffer.wrap(JsonCodec.encode(value));
                    while (bytes.hasRemaining()) {
                        channel.write(bytes);
                    }
                    channel.force(true);
                }
                Files.move(temporary, record, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                syncDirectory(directory);
            } finally {
                Files.deleteIfExists(temporary);
            }
        }
    }

    private void validate(Path path, boolean isDirectory) throws IOException {
        var attributes = Files.readAttributes(path, java.nio.file.attribute.PosixFileAttributes.class,
                LinkOption.NOFOLLOW_LINKS);
        if (isDirectory ? !attributes.isDirectory() : !attributes.isRegularFile()) {
            throw new IOException("Recovery entry has an invalid type");
        }
        if (!attributes.owner().equals(owner) || !attributes.permissions().equals(
                PosixFilePermissions.fromString(isDirectory ? "rwx------" : "rw-------"))) {
            throw new IOException("Recovery entry is not private to its owner");
        }
    }

    private static byte[] readBounded(Path path) throws IOException {
        try (FileChannel channel = FileChannel.open(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            if (channel.size() > RECORD_LIMIT) {
                throw new IOException("Recovery record exceeds its size limit");
            }
            ByteBuffer bytes = ByteBuffer.allocate(RECORD_LIMIT + 1);
            while (bytes.hasRemaining() && channel.read(bytes) != -1) {
                // Read no more than the bounded record even if the file grows.
            }
            if (bytes.position() > RECORD_LIMIT) {
                throw new IOException("Recovery record exceeds its size limit");
            }
            return java.util.Arrays.copyOf(bytes.array(), bytes.position());
        }
    }

    private static RuntimeResourceHandle handle(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            String key, HostIdentity identity) {
        RuntimeScope scope = request.getScope();
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("resourceId", key);
        values.put("hostId", identity.hostId());
        values.put("bootId", identity.bootId());
        values.put("pidNamespace", identity.pidNamespace());
        values.put("timeNamespace", identity.timeNamespace());
        values.put("identityDigest", digest(JsonCodec.encode(List.of(seed.getProvisionRequestId(),
                seed.getProvisionalRuntimeId(), seed.getGatewayIncarnation(), seed.getLeaseId(), seed.getEpoch(),
                scope.getTenantId(), scope.getWorkspaceId(), scope.getWorkspaceGeneration(), scope.getCanonicalCwd(),
                scope.getCapabilityDigest(), scope.getIsolationClass(), request.getProvisionerKind(),
                Objects.toString(request.getIsolationKey(), ""), Objects.toString(request.getStorageId(), "")))));
        return new RuntimeResourceHandle(LocalProcessRuntimeProvisioner.KIND, 2, values);
    }

    private static String digest(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static void syncDirectory(Path directory) throws IOException {
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            channel.force(true);
        }
    }

    private static RuntimeBrokerException busy() {
        return new RuntimeBrokerException(503, "runtime_reconcile_in_progress", "Local Runtime identity is locked.", true);
    }

    static RuntimeBrokerException blocked() {
        return new RuntimeBrokerException(409, "runtime_broker_recovery_blocked",
                "Local Runtime identity cannot be verified.", false);
    }
}
