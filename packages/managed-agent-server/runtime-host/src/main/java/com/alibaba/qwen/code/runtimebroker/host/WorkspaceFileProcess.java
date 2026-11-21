package com.alibaba.qwen.code.runtimebroker.host;

import com.alibaba.qwen.code.managedagent.contracts.workspace.LocalWorkspaceFiles;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Bounded Workspace file exchanges using the configured local CLI. */
public final class WorkspaceFileProcess implements LocalWorkspaceFiles {
    public static final int MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
    public static final int MAX_UPLOAD_REQUEST_BYTES = 12 * 1024 * 1024;
    private static volatile Capability cachedCapability;

    private record FileIdentity(String configured, Path resolved, Object key, long size,
            FileTime created, FileTime modified) { }

    private record Capability(List<FileIdentity> identity, HostCommandRunner.Result help) { }

    public WorkspaceFileProcess() {
    }

    public static Map<String, Object> read(String node, String entry, Map<String, Object> request) {
        return exchange(node, entry, request, false);
    }

    public static Map<String, Object> upload(String node, String entry, Map<String, Object> request) {
        return exchange(node, entry, request, true);
    }

    private static Map<String, Object> exchange(String node, String entry, Map<String, Object> request, boolean upload) {
        if (node == null || node.isBlank() || entry == null || entry.isBlank()) {
            throw unsupported();
        }
        byte[] input = JsonCodec.encode(request);
        if (input.length > (upload ? MAX_UPLOAD_REQUEST_BYTES : 65536)) {
            throw unsupported();
        }
        requireLocalCapability(node, entry, upload);
        List<String> command = upload
                ? List.of(node, entry, "managed-runtime-bootstrap", "--workspace-file-upload")
                : List.of(node, entry, "managed-runtime-bootstrap");
        var exchange = HostCommandRunner.run(command,
                input, Duration.ofSeconds(15));
        if (exchange.exitCode() != 0 || exchange.stdout().length > 65536) {
            throw upload ? uncertain() : unsupported();
        }
        Map<String, Object> envelope;
        try {
            envelope = JsonCodec.parseObject(exchange.stdout(), "Workspace file response");
        } catch (RuntimeException error) {
            if (upload) {
                throw uncertain();
            }
            throw unsupported();
        }
        if (Long.valueOf(1).equals(BrokerValues.exactLong(envelope.get("protocolVersion")))
                && Boolean.TRUE.equals(envelope.get("ok")) && envelope.get("result") instanceof Map<?, ?> result) {
            return JsonCodec.parseObject(JsonCodec.encode(result), "Workspace file result");
        }
        throw upload ? uncertain()
                : new RuntimeBrokerException(409, "workspace_file_unavailable", "Workspace file cannot be read.", false);
    }

    private static void requireLocalCapability(String node, String entry, boolean upload) {
        var identity = identity(node, entry);
        var cached = cachedCapability;
        if (identity != null && cached != null && identity.equals(cached.identity())) {
            requireCapability(cached.help(), upload);
            return;
        }
        var help = HostCommandRunner.run(List.of(node, entry, "managed-runtime-bootstrap", "--help"),
                new byte[]{'{', '}'}, Duration.ofSeconds(15));
        requireCapability(help, upload);
        if (identity != null && identity.equals(identity(node, entry))) {
            cachedCapability = new Capability(identity, help);
        }
    }

    private static List<FileIdentity> identity(String node, String entry) {
        try {
            var identities = new ArrayList<FileIdentity>(2);
            for (String configured : List.of(node, entry)) {
                Path path = Path.of(configured);
                if (!path.isAbsolute()) {
                    return null;
                }
                Path resolved = path.toRealPath();
                var attributes = Files.readAttributes(resolved, BasicFileAttributes.class);
                if (!attributes.isRegularFile()) {
                    return null;
                }
                identities.add(new FileIdentity(configured, resolved, attributes.fileKey(), attributes.size(),
                        attributes.creationTime(), attributes.lastModifiedTime()));
            }
            return List.copyOf(identities);
        } catch (IOException | InvalidPathException unavailable) {
            return null;
        }
    }

    public static RuntimeBrokerException unsupported() {
        return new RuntimeBrokerException(409, "workspace_files_unsupported", "Workspace file access requires an updated CLI.", false);
    }

    private static RuntimeBrokerException uncertain() {
        return new RuntimeBrokerException(503, "workspace_upload_pending", "Original Workspace upload must be reconciled.", true);
    }

    public static void requireCapability(HostCommandRunner.Result help, boolean upload) {
        try {
            if (help.exitCode() != 0 || help.stdout().length > 65536) {
                throw unsupported();
            }
            var document = JsonCodec.parseObject(help.stdout(), "Workspace file capability");
            if (!Long.valueOf(1).equals(BrokerValues.exactLong(document.get("protocolVersion")))
                    || !(document.get("capabilities") instanceof Map<?, ?> capabilities)
                    || !Long.valueOf(1).equals(BrokerValues.exactLong(capabilities.get(upload ? "workspaceFileUpload" : "workspaceFiles")))) {
                throw unsupported();
            }
        } catch (RuntimeException error) {
            throw unsupported();
        }
    }
    public Map<String, Object> readFiles(String node, String entry, Map<String, Object> request) { return read(node, entry, request); }
    public Map<String, Object> uploadFiles(String node, String entry, Map<String, Object> request) { return upload(node, entry, request); }
}
