package com.alibaba.qwen.code.daemon;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/** Typed import, publication and application of Managed extension packages. */
public final class ManagedExtensionPackages {
    private final ManagedExtensionsClient client;

    ManagedExtensionPackages(ManagedExtensionsClient client) {
        this.client = client;
    }

    /** Imports a new Skill, extension or MCP package from a local file. */
    public Publication importPackage(String workspaceId, Path file, ImportOptions options, String idempotencyKey) {
        return importPackage(workspaceId, null, file, options, idempotencyKey);
    }

    /** Imports a revision into the specified extension. */
    public Publication importPackage(String workspaceId, String extensionId, Path file, ImportOptions options,
            String idempotencyKey) {
        return new Publication(client.importPackage(workspaceId, extensionId, file, options.json, idempotencyKey));
    }

    public Publication getPublication(String workspaceId, String operationId) {
        return new Publication(client.packageOperation(workspaceId, operationId));
    }

    /** Finds the original publication by the idempotency key used for import. */
    public Publication lookupPublication(String workspaceId, String idempotencyKey) {
        return new Publication(client.lookupPackageOperation(workspaceId, "publish", idempotencyKey));
    }

    /** Retrieves the package pin from a settled publication. Select settings separately. */
    public ManagedExtensionPin getPublishedPin(String workspaceId, Publication publication) {
        String digest = publication.getPackageDigest();
        if (!publication.isSettled() || digest == null) {
            throw new IllegalArgumentException("A settled publication with a package digest is required");
        }
        return getPublishedPin(workspaceId, publication.getExtensionId(), publication.getRevision(), digest);
    }

    public ManagedExtensionPin getPublishedPin(String workspaceId, String extensionId, long revision, String digest) {
        var version = client.packageVersion(workspaceId, extensionId, revision, digest);
        return new ManagedExtensionPin(JsonSupport.requiredObject(version, "pin", "Managed package version"));
    }

    public Settings getSettings(String workspaceId, String extensionId) {
        return new Settings(client.settings(workspaceId, extensionId));
    }

    /** Replaces the complete set of settings at the expected revision and returns the saved revision. */
    public SettingsUpdate saveSettings(String workspaceId, String extensionId, long expectedRevision,
            Map<String, String> values, String idempotencyKey) {
        return new SettingsUpdate(client.saveSettings(workspaceId, extensionId, expectedRevision, values, idempotencyKey));
    }

    public Configuration getConfiguration(String sessionId) {
        return new Configuration(client.configuration(sessionId));
    }

    /** Replaces the specified Session's extension selection at the expected configuration revision. */
    public Configuration apply(String sessionId, long expectedRevision, List<ManagedExtensionPin> pins,
            String idempotencyKey) {
        return new Configuration(client.apply(sessionId, expectedRevision,
                pins.stream().map(ManagedExtensionPin::json).collect(Collectors.toList()), idempotencyKey));
    }

    public Configuration getConfigurationOperation(String sessionId, String operationId) {
        return new Configuration(client.configurationOperation(sessionId, operationId));
    }

    /** Looks up an apply whose reply was lost, using the original idempotency key. */
    public Configuration lookupConfigurationOperation(String sessionId, String idempotencyKey) {
        return new Configuration(client.lookupConfigurationOperation(sessionId, idempotencyKey));
    }

    public enum SourceKind {
        SKILL("skill"),
        EXTENSION("extension"),
        MCP("mcp");

        private final String wire;

        SourceKind(String wire) {
            this.wire = wire;
        }
    }

    public enum Platform {
        LINUX("linux"),
        DARWIN("darwin");

        private final String wire;

        Platform(String wire) {
            this.wire = wire;
        }
    }

    public enum Architecture {
        X64("x64"),
        ARM64("arm64"),
        ANY("any");

        private final String wire;

        Architecture(String wire) {
            this.wire = wire;
        }
    }

    /** Import metadata. SDK computes the archive digest and sets compiler version 1. */
    public static final class ImportOptions {
        private final Map<String, Object> json;

        public ImportOptions(SourceKind sourceKind, Platform platform, Architecture architecture) {
            this(sourceKind, platform, architecture, null);
        }

        public ImportOptions(SourceKind sourceKind, Platform platform, Architecture architecture, String packageName) {
            json = new LinkedHashMap<>(Map.of("sourceKind", sourceKind.wire, "compilerVersion", 1,
                    "target", Map.of("platform", platform.wire, "arch", architecture.wire)));
            ManagedJson.put(json, "packageName", packageName);
        }
    }

    /** Current settings revision and configured names. Values are write-only. */
    public static final class Settings extends ManagedJson {
        private Settings(Map<String, Object> json) {
            super(json);
        }

        public long getRevision() {
            return number("settingsRevision");
        }

        public List<String> getConfiguredKeys() {
            return List.copyOf(JsonSupport.stringList(json(), "configuredKeys"));
        }
    }

    /** Receipt for saving a new settings revision. */
    public static final class SettingsUpdate extends ManagedJson {
        private SettingsUpdate(Map<String, Object> json) {
            super(json);
        }

        public String getOperationId() {
            return string("operationId");
        }

        public String getExtensionId() {
            return string("extensionId");
        }

        public long getRevision() {
            return number("revision");
        }

        public String getState() {
            return string("state");
        }
    }

    /** Workspace package publication state. */
    public static final class Publication extends ManagedJson {
        private Publication(Map<String, Object> json) {
            super(json);
        }

        public String getOperationId() {
            return string("operationId");
        }

        public String getExtensionId() {
            return string("extensionId");
        }

        public String getKind() {
            return string("kind");
        }

        public String getState() {
            return string("state");
        }

        public boolean isSettled() {
            return "settled".equals(getState());
        }

        public long getRevision() {
            return number("revision");
        }

        public String getPackageDigest() {
            return optionalString("packageDigest");
        }
    }

    /** Effective and requested extension selections for the Session. */
    public static final class Configuration extends ManagedJson {
        private Configuration(Map<String, Object> json) {
            super(json);
        }

        public String getSessionId() {
            return string("sessionId");
        }

        public boolean isSupported() {
            return flag("supported");
        }

        public long getRevision() {
            return number("revision");
        }

        public List<ManagedExtensionPin> getExtensions() {
            return objects("extensions", ManagedExtensionPin::new);
        }

        public List<ManagedExtensionPin> getRequestedExtensions() {
            return objects("requestedExtensions", ManagedExtensionPin::new);
        }

        public Map<String, Object> getDegradedComponents() {
            return optionalObject("degradedComponents");
        }

        public ApplyOperation getOperation() {
            return optionalObject("operation", ApplyOperation::new);
        }

        public SelfService getSelfService() {
            return optionalObject("selfService", SelfService::new);
        }
    }

    /** Applies when the caller has permission to manage the Session's extension selection. */
    public static final class SelfService extends ManagedJson {
        private SelfService(Map<String, Object> json) {
            super(json);
        }

        public boolean isSupported() {
            return flag("supported");
        }

        public boolean canApply() {
            return flag("canApply");
        }

        public Boolean isRuntimeSkillImportSupported() {
            return optionalFlag("runtimeSkillImportSupported");
        }
    }

    /** Asynchronous application of the requested selection. */
    public static final class ApplyOperation extends ManagedJson {
        private ApplyOperation(Map<String, Object> json) {
            super(json);
        }

        public String getId() {
            return string("operationId");
        }

        public String getState() {
            return string("state");
        }

        public String getMode() {
            return string("mode");
        }

        public long getRevision() {
            return number("revision");
        }

        public Map<String, Object> getError() {
            return optionalObject("error");
        }
    }
}
