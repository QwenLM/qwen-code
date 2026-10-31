package com.alibaba.qwen.code.managedagent.extensions;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchives;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Catalog;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Manifest;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Operation;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Package;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Settings;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.SettingsCommand;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ExtensionPackageRepository;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;

@Service
public class ManagedExtensionPackageService implements ExtensionPackages {
    private final ExtensionPackageRepository repository;
    private final ManagedWorkspaceRegistry workspaces;
    private final ManagedAgentSettings properties;
    private final ExtensionArchives archives;
    private final ObjectMapper json;

    public ManagedExtensionPackageService(ExtensionPackageRepository repository,
            ManagedWorkspaceRegistry workspaces, ManagedAgentSettings properties,
            ExtensionArchives archives, @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.repository = repository;
        this.workspaces = workspaces;
        this.properties = properties;
        this.archives = archives;
        this.json = json;
    }
    public Catalog list(String tenant, String actor, String workspace) {
        requireAccess(tenant, actor, workspace, false);
        var packages = repository.list(tenant, workspace);
        return new Catalog(properties.getExtensions().isEnabled() && archives.configured(), packages);
    }

    public void requireExecutionAccess(String tenant, String actor, String workspace) {
        requireAccess(tenant, actor, workspace, true);
    }

    public void requireSelection(String tenant, String actor, String workspace, List<Pin> pins) {
        requireExecutionAccess(tenant, actor, workspace);
        if (pins == null || pins.size() > 32 || pins.stream().anyMatch(java.util.Objects::isNull)
                || pins.stream().map(Pin::extensionId).distinct().count() != pins.size()) {
            throw invalid();
        }
        for (Pin pin : pins) {
            repository.get(tenant, workspace, pin);
            if (pin.settingsRevision() != null && !repository.hasSettings(tenant, workspace, pin)) {
                throw missing();
            }
        }
    }

    public Manifest decodeManifest(String encoded) {
        try {
            if (encoded == null || encoded.length() > ((ManagedExtensionPackages.MAX_MANIFEST_BYTES + 2) / 3) * 4) {
                throw invalid();
            }
            byte[] bytes = Base64.getUrlDecoder().decode(encoded);
            if (bytes.length > ManagedExtensionPackages.MAX_MANIFEST_BYTES) {
                throw invalid();
            }
            Manifest manifest = json.readValue(bytes, Manifest.class);
            if (manifest == null || manifest.schemaVersion() != 1 || manifest.compilerVersion() != 1
                    || manifest.name() == null || !manifest.name().matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
                    || manifest.version() == null || manifest.version().isBlank() || manifest.version().length() > 128
                    || manifest.target() == null || manifest.target().platform() == null || manifest.target().arch() == null
                    || !Set.of("linux", "darwin").contains(manifest.target().platform())
                    || !Set.of("x64", "arm64", "any").contains(manifest.target().arch())
                    || manifest.components() == null || manifest.components().size() > ManagedExtensionPackages.COMPONENTS.size()
                    || manifest.components().stream().anyMatch(java.util.Objects::isNull)
                    || !ManagedExtensionPackages.COMPONENTS.containsAll(manifest.components())
                    || Set.copyOf(manifest.components()).size() != manifest.components().size()
                    || (manifest.sourceType() == null) != (manifest.sourceRevision() == null)
                    || manifest.sourceType() != null && (!Set.of("git", "github-release", "npm", "directory", "archive",
                            "archive-url", "link", "snapshot").contains(manifest.sourceType())
                    || manifest.sourceRevision().isBlank() || manifest.sourceRevision().length() > 256
                    || manifest.sourceRevision().chars().anyMatch(Character::isISOControl))) {
                throw invalid();
            }
            return manifest;
        } catch (IOException | IllegalArgumentException error) {
            throw invalid();
        }
    }

    public Operation publish(String tenant, String actor, String workspace, String extensionId,
            String digest, String idempotencyKey, Manifest manifest, InputStream archive) throws IOException {
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        requireDigest(digest);
        String operationId = operationId(tenant, actor, workspace, "publish", idempotencyKey);
        String id = extensionId == null ? "ext_" + UUID.nameUUIDFromBytes(operationId.getBytes(StandardCharsets.UTF_8)) : extensionId;
        requireId(id);
        String encodedManifest = encode(manifest);
        String requestDigest = DigestUtils.sha256Hex(encode(List.of(id, digest, manifest)));
        Operation operation = repository.preparePublish(tenant, actor, workspace, extensionId, id, digest,
                operationId, requestDigest, encodedManifest, write -> requireAccess(tenant, actor, workspace, write));
        if ("settled".equals(operation.state())) {
            return operation;
        }
        long length = archives.put(tenant, workspace, digest, archive);
        return repository.finishPublish(tenant, actor, workspace, id, digest, operationId, length, operation,
                write -> requireAccess(tenant, actor, workspace, write));
    }

    public Operation operation(String tenant, String actor, String workspace, String operationId) {
        return repository.operation(tenant, actor, workspace, operationId,
                write -> requireAccess(tenant, actor, workspace, write));
    }

    public Package get(String tenant, String actor, String workspace, String extensionId, long revision, String digest) {
        requireAccess(tenant, actor, workspace, false);
        return repository.get(tenant, workspace, new Pin(extensionId, revision, digest, null));
    }

    public Path archive(String tenant, String actor, String workspace, String extensionId, long revision,
            String digest) throws IOException {
        Package saved = get(tenant, actor, workspace, extensionId, revision, digest);
        return archives.verify(tenant, workspace, digest, saved.byteLength());
    }

    public Settings settings(String tenant, String actor, String workspace, String extensionId) {
        return repository.settings(tenant, actor, workspace, extensionId,
                write -> requireAccess(tenant, actor, workspace, write));
    }

    public Operation saveSettings(String tenant, String actor, String workspace, String extensionId,
            String idempotencyKey, SettingsCommand command) {
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        requireId(extensionId);
        if (command == null || command.expectedRevision() < 0 || command.expectedRevision() >= 9_007_199_254_740_991L
                || command.values() == null || command.values().size() > 128
                || command.values().entrySet().stream().anyMatch(entry -> entry.getKey() == null
                        || !entry.getKey().matches("[A-Za-z_][A-Za-z0-9_]{0,127}") || entry.getValue() == null)) {
            throw invalid();
        }
        byte[] plaintext = encode(new TreeMap<>(command.values())).getBytes(StandardCharsets.UTF_8);
        if (plaintext.length > ManagedExtensionPackages.MAX_SETTINGS_BYTES) {
            throw new ManagedAgentException(413, "extension_settings_too_large",
                    "Extension settings exceed 8 KiB.");
        }
        String operationId = operationId(tenant, actor, workspace, "settings", idempotencyKey);
        String requestDigest = DigestUtils.sha256Hex(encode(List.of(extensionId, command.expectedRevision())));
        return repository.saveSettings(tenant, actor, workspace, extensionId, operationId, requestDigest, command, plaintext,
                write -> requireAccess(tenant, actor, workspace, write));
    }

    public ResolvedPackage resolvePin(String tenant, String workspace, Pin pin) throws IOException {
        Package saved = repository.get(tenant, workspace, pin);
        Map<String, String> settings = pin.settingsRevision() == null ? Map.of()
                : repository.settingsValues(tenant, workspace, pin.extensionId(), pin.settingsRevision());
        return new ResolvedPackage(saved, archives.verify(tenant, workspace, pin.packageDigest(), saved.byteLength()), settings);
    }

    private void requireAccess(String tenant, String actor, String workspace, boolean write) {
        WorkspaceAccess access = workspaces.accessOf(tenant, actor, workspace);
        if (!access.canRead()) {
            throw missing();
        }
        if (write && (!access.atLeast(WorkspaceAccess.OPERATOR)
                || !properties.getExtensions().isEnabled() || !archives.configured()
                || !(properties.getExtensions().getAllowedActors().contains(actor)
                || properties.getExtensions().getAllowedActors().contains("*")))) {
            throw new ManagedAgentException(403, "extension_management_forbidden",
                    "Extension management requires a Workspace operator and deployment permission.");
        }
    }

    private String encode(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (IOException error) {
            throw new IllegalStateException("Cannot encode extension record", error);
        }
    }

    private static String operationId(String tenant, String actor, String workspace, String kind, String key) {
        return "eop_" + ManagedSchemaKeys.key(tenant, actor, workspace, kind, key);
    }

    private static void requireId(String id) {
        if (id == null || !id.matches("ext_[a-f0-9-]{36}")) {
            throw invalid();
        }
    }

    private static void requireDigest(String digest) {
        if (digest == null || !digest.matches("[a-f0-9]{64}")) {
            throw invalid();
        }
    }

    private static ManagedAgentException invalid() {
        return new ManagedAgentException(400, "invalid_request", "Invalid extension package request.");
    }

    private static ManagedAgentException missing() {
        return new ManagedAgentException(404, "extension_package_not_found", "Extension package was not found.");
    }
}
