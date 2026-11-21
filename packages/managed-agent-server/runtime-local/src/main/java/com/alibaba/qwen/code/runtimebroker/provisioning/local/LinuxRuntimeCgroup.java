package com.alibaba.qwen.code.runtimebroker.provisioning.local;

import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SecureDirectoryStream;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributeView;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** The Broker owns this Linux cgroup directory and the durable identity used to reopen it. */
record LinuxRuntimeCgroup(Path root, String namespace, String rootKey, String unitKey, String resourceId) {
    private static final String TRAMPOLINE = """
            printf '%s\\n' "$$" > "$1" || exit 125
            shift
            IFS= read -r gate && [ "$gate" = start ] || exit 125
            exec "$@"
            """;
    private static final Path PROCS = Path.of("cgroup.procs");
    private static final Path EVENTS = Path.of("cgroup.events");
    private static final Path KILL = Path.of("cgroup.kill");

    LinuxRuntimeCgroup {
        if (!root.isAbsolute() || !root.equals(root.normalize())
                || !resourceId.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Invalid local Runtime cgroup identity");
        }
    }

    static void validateRoot(Path root) throws IOException {
        if (!"Linux".equals(System.getProperty("os.name"))
                || !root.isAbsolute() || !root.toRealPath().equals(root)
                || root.getParent() == null || !"cgroup2".equals(Files.getFileStore(root.getParent()).type())
                || !"cgroup2".equals(Files.getFileStore(root).type())
                || !"domain".equals(Files.readString(root.resolve("cgroup.type")).strip())
                || !Files.isWritable(root)) {
            throw new IOException("Expected a writable delegated cgroup v2 domain directory.");
        }
    }

    static LinuxRuntimeCgroup create(Path root, String resourceId) throws IOException {
        validateRoot(root);
        Path name = Path.of("qwen-runtime-" + resourceId);
        try (var parent = secure(root)) {
            String parentKey = key(parent);
            Path path = root.resolve(name);
            Files.createDirectory(path);
            try (var child = parent.newDirectoryStream(name, LinkOption.NOFOLLOW_LINKS)) {
                if (!empty(child) || !Files.isWritable(path.resolve(PROCS)) || !Files.isWritable(path.resolve(KILL))
                        || !Files.isReadable(path.resolve(PROCS))) {
                    throw new IOException("The delegated cgroup cannot enroll and stop a Runtime.");
                }
                return new LinuxRuntimeCgroup(root, currentNamespace(), parentKey, key(child), resourceId);
            } catch (IOException | RuntimeException failure) {
                try {
                    parent.deleteDirectory(name);
                } catch (IOException cleanup) {
                    failure.addSuppressed(cleanup);
                }
                throw failure;
            }
        }
    }

    static LinuxRuntimeCgroup saved(RuntimeResourceHandle handle) {
        Map<String, Object> values = handle.getValue();
        if (!(values.get("cgroupRoot") instanceof String root)
                || !(values.get("cgroupNamespace") instanceof String namespace)
                || !(values.get("cgroupRootKey") instanceof String rootKey)
                || !(values.get("cgroupUnitKey") instanceof String unitKey)
                || !(values.get("resourceId") instanceof String resourceId)) {
            throw new IllegalArgumentException("Missing local Runtime cgroup identity");
        }
        return new LinuxRuntimeCgroup(Path.of(root), namespace, rootKey, unitKey, resourceId);
    }

    void writeIdentity(Map<String, Object> values) {
        values.put("cgroupRoot", root.toString());
        values.put("cgroupNamespace", namespace);
        values.put("cgroupRootKey", rootKey);
        values.put("cgroupUnitKey", unitKey);
    }

    ProcessBuilder prepare(ProcessBuilder builder) throws IOException {
        if (!empty()) {
            throw new IOException("The original Runtime cgroup is already populated.");
        }
        var command = new ArrayList<>(List.of("/bin/sh", "-c", TRAMPOLINE, "qwen-cgroup",
                root.resolve(name()).resolve(PROCS).toString()));
        command.addAll(builder.command());
        builder.command(command);
        builder.environment().remove("QWEN_MANAGED_HOOK_CGROUP_ROOT");
        return builder;
    }

    void awaitMember(Process process, Duration timeout) throws IOException {
        long deadline = System.nanoTime() + timeout.toNanos();
        try (var child = open()) {
            while (process.isAlive() && System.nanoTime() < deadline) {
                if (contains(child, process.pid()) && process.isAlive()) {
                    return;
                }
                pause();
            }
        }
        throw new IOException("The Runtime did not join its original cgroup.");
    }

    boolean contains(long pid) throws IOException {
        try (var child = open()) {
            return contains(child, pid);
        }
    }

    boolean empty() throws IOException {
        try (var child = open()) {
            return empty(child);
        }
    }

    void killAndWait(Duration timeout) throws IOException {
        long deadline = System.nanoTime() + timeout.toNanos();
        try (var child = open()) {
            if (empty(child)) {
                return;
            }
            try (var control = child.newByteChannel(KILL, Set.of(StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS))) {
                if (control.write(ByteBuffer.wrap(new byte[] {'1'})) != 1) {
                    throw new IOException("Incomplete cgroup stop request.");
                }
            }
            while (System.nanoTime() < deadline) {
                if (empty(child)) {
                    return;
                }
                pause();
            }
        }
        throw new IOException("The original Runtime cgroup remains populated.");
    }

    void removeEmpty() {
        try (var parent = openRoot();
                var child = parent.newDirectoryStream(name(), LinkOption.NOFOLLOW_LINKS)) {
            if (unitKey.equals(key(child)) && empty(child)) {
                parent.deleteDirectory(name());
            }
        } catch (IOException ignored) {
            // Cleanup is best-effort after the original stop proof is durable.
        }
    }

    private Path name() {
        return Path.of("qwen-runtime-" + resourceId);
    }

    private SecureDirectoryStream<Path> openRoot() throws IOException {
        if (!namespace.equals(currentNamespace()) || !root.toRealPath().equals(root)) {
            throw new IOException("The original Runtime cgroup namespace or path changed.");
        }
        var parent = secure(root);
        try {
            if (!rootKey.equals(key(parent))) {
                throw new IOException("The original Runtime cgroup root changed.");
            }
            return parent;
        } catch (IOException | RuntimeException failure) {
            parent.close();
            throw failure;
        }
    }

    private SecureDirectoryStream<Path> open() throws IOException {
        try (var parent = openRoot()) {
            var child = parent.newDirectoryStream(name(), LinkOption.NOFOLLOW_LINKS);
            try {
                if (!unitKey.equals(key(child))) {
                    throw new IOException("The original Runtime cgroup changed.");
                }
                return child;
            } catch (IOException | RuntimeException failure) {
                child.close();
                throw failure;
            }
        }
    }

    private static SecureDirectoryStream<Path> secure(Path path) throws IOException {
        var directory = Files.newDirectoryStream(path);
        if (directory instanceof SecureDirectoryStream<Path> secure) {
            return secure;
        }
        directory.close();
        throw new IOException("Descriptor-relative cgroup access is unavailable.");
    }

    private static String currentNamespace() throws IOException {
        return Files.readSymbolicLink(Path.of("/proc/self/ns/cgroup")).toString();
    }

    private static String key(SecureDirectoryStream<Path> dir) throws IOException {
        Object key = dir.getFileAttributeView(BasicFileAttributeView.class).readAttributes().fileKey();
        if (key == null) {
            throw new IOException("The kernel cgroup identity is unavailable.");
        }
        return key.toString();
    }

    private static boolean contains(SecureDirectoryStream<Path> child, long pid) throws IOException {
        try (var input = new BufferedReader(Channels.newReader(
                child.newByteChannel(PROCS, Set.of(LinkOption.NOFOLLOW_LINKS)), StandardCharsets.US_ASCII))) {
            String expected = Long.toString(pid);
            for (String line; (line = input.readLine()) != null;) {
                if (expected.equals(line)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean empty(SecureDirectoryStream<Path> child) throws IOException {
        try (var input = Channels.newInputStream(child.newByteChannel(EVENTS, Set.of(LinkOption.NOFOLLOW_LINKS)))) {
            byte[] contents = input.readNBytes(1024);
            var populated = new String(contents, StandardCharsets.US_ASCII).lines()
                    .filter(line -> line.startsWith("populated ")).toList();
            if (contents.length < 1024 && populated.equals(List.of("populated 0"))) {
                return true;
            }
            if (contents.length < 1024 && populated.equals(List.of("populated 1"))) {
                return false;
            }
        }
        throw new IOException("The original Runtime cgroup population could not be established.");
    }

    private static void pause() throws IOException {
        try {
            Thread.sleep(25);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("The Runtime cgroup check was interrupted.", interrupted);
        }
    }
}
