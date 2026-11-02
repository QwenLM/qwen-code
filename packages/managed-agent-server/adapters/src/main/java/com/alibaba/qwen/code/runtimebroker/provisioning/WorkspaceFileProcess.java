package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;

import java.time.Duration;
import java.util.List;
import java.util.Map;

/** Bounded Workspace file exchanges using the configured local CLI. */
public final class WorkspaceFileProcess implements com.alibaba.qwen.code.managedagent.contracts.workspace.LocalWorkspaceFiles {
    public static final int MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
    public static final int MAX_UPLOAD_REQUEST_BYTES = 12 * 1024 * 1024;
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
        var help = SshConnectionManager.runCommand(List.of(node, entry, "managed-runtime-bootstrap", "--help"),
                new byte[]{'{', '}'}, Duration.ofSeconds(15));
        requireCapability(help, upload);
        List<String> command = upload
                ? List.of(node, entry, "managed-runtime-bootstrap", "--workspace-file-upload")
                : List.of(node, entry, "managed-runtime-bootstrap");
        var exchange = SshConnectionManager.runCommand(command,
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

    public static RuntimeBrokerException unsupported() {
        return new RuntimeBrokerException(409, "workspace_files_unsupported", "Workspace file access requires an updated CLI.", false);
    }

    private static RuntimeBrokerException uncertain() {
        return new RuntimeBrokerException(503, "workspace_upload_pending", "Original Workspace upload must be reconciled.", true);
    }

    static void requireCapability(SshConnectionManager.CommandResult help) {
        requireCapability(help, false);
    }

    static void requireCapability(SshConnectionManager.CommandResult help, boolean upload) {
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
