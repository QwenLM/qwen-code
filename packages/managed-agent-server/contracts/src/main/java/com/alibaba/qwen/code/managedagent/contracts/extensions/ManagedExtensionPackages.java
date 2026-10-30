package com.alibaba.qwen.code.managedagent.contracts.extensions;

import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.Map;

public final class ManagedExtensionPackages {
    public static final long MAX_ARCHIVE_BYTES = 100L * 1024 * 1024;
    public static final int MAX_MANIFEST_BYTES = 64 * 1024;
    public static final int MAX_SETTINGS_BYTES = 8 * 1024;
    public static final List<String> COMPONENTS =
            List.of("skills", "commands", "agents", "context", "mcp", "hooks", "settings");

    private ManagedExtensionPackages() { }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Pin(String extensionId, long packageRevision, String packageDigest,
            Long settingsRevision) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown extension pin field");
        }
    }

    public record Target(String platform, String arch) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown extension target field");
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Manifest(int schemaVersion, int compilerVersion, String name, String version,
            Target target, List<String> components, String sourceType, String sourceRevision) {
        public Manifest(int schemaVersion, int compilerVersion, String name, String version,
                Target target, List<String> components) {
            this(schemaVersion, compilerVersion, name, version, target, components, null, null);
        }

        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown extension manifest field");
        }
    }

    public record Package(Pin pin, Manifest manifest, long byteLength) {
    }

    public record Catalog(boolean supported, List<Package> extensions) {
    }

    public record Settings(long settingsRevision, List<String> configuredKeys) {
    }

    public record SettingsCommand(long expectedRevision, Map<String, String> values) {
        @Override
        public String toString() {
            return "SettingsCommand[expectedRevision=" + expectedRevision + ", values=redacted]";
        }

        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown extension settings field");
        }
    }

    public record Operation(String operationId, String extensionId, String kind,
            String state, long revision, String packageDigest) {
    }
}
