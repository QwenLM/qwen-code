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
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.SourceOrigin;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionSource;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ExtensionPackageRepository;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Instant;
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
    private HarnessConnector harness;
    private Map<String, ManagedExtensionSource> sources = Map.of();
    private final java.util.concurrent.Semaphore sourceStaging = new java.util.concurrent.Semaphore(4);

    @org.springframework.beans.factory.annotation.Autowired
    public void configurePreparation(@org.springframework.context.annotation.Lazy HarnessConnector value) { harness = value; }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void configureSources(List<ManagedExtensionSource> providers) {
        Map<String, ManagedExtensionSource> registry = new java.util.LinkedHashMap<>();
        for (ManagedExtensionSource source : providers) {
            if (source.id() == null || !source.id().matches("[a-z][a-z0-9-]{0,63}")
                    || registry.putIfAbsent(source.id(), source) != null) {
                throw new IllegalStateException("Invalid or duplicate Managed extension source ID");
            }
        }
        sources = Map.copyOf(registry);
    }

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
        var packages = repository.list(tenant, workspace).stream().filter(entry -> visible(tenant, actor, workspace, entry)).toList();
        boolean supported = selfServiceSupported();
        return new Catalog(properties.getExtensions().isEnabled() && archives.configured(), packages,
                new ManagedExtensionPackages.SelfService(supported, supported && canPublish(tenant, actor, workspace)));
    }

    public boolean supported() { return properties.getExtensions().isEnabled() && archives.configured(); }

    private boolean visible(String tenant, String actor, String workspace, Package entry) {
        try {
            authorizeSource(tenant, actor, workspace, entry);
            return true;
        } catch (ManagedAgentException error) {
            if (error.getStatus() == 404) {
                return false;
            }
            throw error;
        }
    }

    private void authorizeSource(String tenant, String actor, String workspace, Package entry) {
        if (entry.source() != null) {
            var resolved = resolveSource(context(tenant, actor, workspace, UUID.randomUUID().toString()), entry.source().reference());
            if (!entry.source().reference().equals(resolved.reference())) {
                throw new ManagedAgentException(409, "extension_source_changed", "The saved source identity has changed.");
            }
        }
    }

    private ManagedExtensionSource.Context context(String tenant, String actor, String workspace, String requestId) {
        return new ManagedExtensionSource.Context(tenant, actor, workspace, requestId, Instant.now().plusSeconds(120));
    }

    private ManagedExtensionSource.Resolved resolveSource(ManagedExtensionSource.Context context, ManagedExtensionSource.Reference reference) {
        if (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Business extension sources must be resolved outside Managed SQL transactions");
        }
        var provider = sources.get(reference.providerId());
        if (provider == null) {
            throw new ManagedAgentException(503, "extension_source_unavailable", "The extension source provider is unavailable.");
        }
        try {
            context.checkDeadline();
            var result = provider.resolve(context, reference);
            context.checkDeadline();
            if (result == null || result.reference() == null || result.archiveId() == null || result.archiveId().isBlank()
                    || !reference.providerId().equals(result.reference().providerId())
                    || !reference.kind().equals(result.reference().kind()) || !reference.revision().equals(result.reference().revision())) {
                throw new ManagedAgentException(409, "extension_source_invalid", "The extension source returned a different revision.");
            }
            if (result.expectedDigest() != null) {
                requireDigest(result.expectedDigest());
            }
            return result;
        } catch (ManagedExtensionSource.Failure error) {
            throw sourceFailure(error);
        } catch (IOException error) {
            throw new ManagedAgentException(503, "extension_source_unavailable", "The extension source is unavailable.", error);
        }
    }

    private static ManagedAgentException sourceFailure(ManagedExtensionSource.Failure error) {
        return switch (error.reason()) {
            case NOT_FOUND -> new ManagedAgentException(404, "extension_package_not_found", "Extension package was not found.", error);
            case UNAVAILABLE -> new ManagedAgentException(503, "extension_source_unavailable", "The extension source is unavailable.", error);
            case INVALID_SOURCE -> new ManagedAgentException(409, "extension_source_invalid", "The extension source archive is invalid.", error);
        };
    }

    public ManagedExtensionPackages.SourceImportResult importSource(String tenant, String actor, String workspace,
            String key, ManagedExtensionPackages.SourceImport command) throws IOException {
        ManagedAgentService.validateIdempotencyKey(key);
        requireExecutionAccess(tenant, actor, workspace);
        if (command == null || command.reference() == null || command.target() == null) {
            throw invalid();
        }
        decodeImportMetadata(encode(new ManagedExtensionPackages.ImportMetadata(command.reference().kind(), command.target(), "0".repeat(64), 1, null)));
        String requestDigest = DigestUtils.sha256Hex(encode(command));
        String operationId = operationId(tenant, actor, workspace, "source-import", key);
        repository.prepareSourceImport(tenant, actor, workspace, operationId, requestDigest, command,
                write -> requireAccess(tenant, actor, workspace, write));
        Operation recorded = repository.findOperation(tenant, actor, workspace, operationId, requestDigest,
                write -> requireAccess(tenant, actor, workspace, write));
        if (recorded != null && "settled".equals(recorded.state())) {
            return sourceResult(tenant, workspace, recorded);
        }
        requireSelfService();
        var context = context(tenant, actor, workspace, operationId);
        var resolved = resolveSource(context, command.reference());
        if (!sourceStaging.tryAcquire()) {
            throw new ManagedAgentException(503, "extension_staging_busy", "Extension source staging is busy.");
        }
        java.nio.file.Path temporary = null;
        try {
            temporary = Files.createTempFile("managed-extension-source-", ".archive");
            var hash = DigestUtils.getSha256Digest();
            long length = 0;
            try (var source = sources.get(resolved.reference().providerId()).open(context, resolved);
                    var output = Files.newOutputStream(temporary)) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = source.read(buffer)) != -1) {
                    context.checkDeadline();
                    length += count;
                    if (length > ManagedExtensionPackages.MAX_ARCHIVE_BYTES) {
                        throw new ManagedAgentException(413, "extension_package_too_large", "Extension source exceeds 100 MiB.");
                    }
                    hash.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
                context.checkDeadline();
            } catch (IOException error) {
                throw new ManagedAgentException(503, "extension_source_unavailable", "The extension source archive cannot be read.", error);
            }
            String sourceDigest = org.apache.commons.codec.binary.Hex.encodeHexString(hash.digest());
            if (length == 0 || resolved.expectedDigest() != null && !resolved.expectedDigest().equals(sourceDigest)) {
                throw new ManagedAgentException(409, "extension_source_changed", "The source archive does not match its revision.");
            }
            var input = decodeImportMetadata(encode(new ManagedExtensionPackages.ImportMetadata(
                    resolved.reference().kind(), command.target(), sourceDigest, 1, null)));
            try (var source = Files.newInputStream(temporary);
                    var prepared = prepareCall(() -> harness.preparePackage(envelope(tenant, actor, workspace, input), source))) {
                JsonNode descriptor = json.valueToTree(prepared.descriptor());
                String digest = descriptor.path("packageDigest").asText();
                requireDigest(digest);
                var manifest = decodeManifest(Base64.getUrlEncoder().withoutPadding()
                        .encodeToString(json.writeValueAsBytes(descriptor.get("manifest"))));
                if (!command.target().equals(manifest.target())) {
                    throw new ManagedAgentException(409, "package_target_mismatch", "Prepared package target differs.");
                }
                var reference = resolved.reference();
                String id = "ext_" + UUID.nameUUIDFromBytes(ManagedSchemaKeys.key("source", tenant, workspace,
                        reference.providerId(), reference.kind(), reference.resourceId()).getBytes(StandardCharsets.UTF_8));
                var previous = repository.list(tenant, workspace).stream().filter(entry -> id.equals(entry.pin().extensionId())).findFirst();
                if (previous.isPresent() && !previous.get().manifest().name().equals(manifest.name())) {
                    throw new ManagedAgentException(409, "extension_namespace_conflict", "An update must retain the package namespace.");
                }
                var origin = new SourceOrigin(reference, sourceDigest, requestDigest);
                var operation = repository.preparePublish(tenant, actor, workspace, previous.isPresent() ? id : null, id,
                        digest, operationId, requestDigest, encode(manifest), origin, write -> requireAccess(tenant, actor, workspace, write));
                if (!"settled".equals(operation.state())) {
                    long bytes = archives.put(tenant, workspace, operation.packageDigest(), prepared.archive());
                    operation = repository.finishPublish(tenant, actor, workspace, id, operation.packageDigest(), operationId,
                            bytes, operation, write -> requireAccess(tenant, actor, workspace, write));
                }
                return sourceResult(tenant, workspace, operation);
            }
        } catch (ManagedExtensionSource.Failure error) {
            throw sourceFailure(error);
        } finally {
            try {
                if (temporary != null) {
                    Files.deleteIfExists(temporary);
                }
            } finally {
                sourceStaging.release();
            }
        }
    }

    public ManagedExtensionPackages.SourceImportResult sourceReceipt(String tenant, String actor, String workspace, String operationId) {
        var command = repository.sourceImport(tenant, actor, workspace, operationId,
                write -> requireAccess(tenant, actor, workspace, write));
        var operation = repository.findOperation(tenant, actor, workspace, operationId, DigestUtils.sha256Hex(encode(command)),
                write -> requireAccess(tenant, actor, workspace, write));
        return operation == null ? new ManagedExtensionPackages.SourceImportResult(operationId, "pending", command.reference(), null, null, null)
                : sourceResult(tenant, workspace, operation);
    }

    public ManagedExtensionPackages.SourceImportResult lookupSourceImport(String tenant, String actor, String workspace, String key) {
        ManagedAgentService.validateIdempotencyKey(key);
        return sourceReceipt(tenant, actor, workspace, operationId(tenant, actor, workspace, "source-import", key));
    }

    private ManagedExtensionPackages.SourceImportResult sourceResult(String tenant, String workspace, Operation operation) {
        Package saved = repository.publication(tenant, workspace, operation);
        if (saved.source() == null) {
            throw missing();
        }
        return new ManagedExtensionPackages.SourceImportResult(operation, saved.source(), saved.pin());
    }

    public boolean canPublish(String tenant, String actor, String workspace) {
        return workspaces.accessOf(tenant, actor, workspace).atLeast(WorkspaceAccess.OPERATOR)
                && properties.getExtensions().isEnabled() && archives.configured()
                && (properties.getExtensions().getAllowedActors().contains(actor)
                || properties.getExtensions().getAllowedActors().contains("*"));
    }

    private boolean supportsPreparation() { return harness != null && harness.supportsPackagePreparation(); }

    public boolean selfServiceSupported() { return properties.getExtensions().isSelfServiceEnabled() && supportsPreparation(); }

    public boolean runtimeSkillImportEnabled() { return selfServiceSupported() && properties.getExtensions().isRuntimeSkillImportEnabled(); }

    private void requireSelfService() {
        if (!selfServiceSupported()) {
            throw new ManagedAgentException(409, "unsupported_feature", "Managed self-service installation is unavailable.");
        }
    }

    public ManagedExtensionPackages.ImportMetadata decodeImportMetadata(String encoded) {
        try {
            if (encoded == null || encoded.length() > 16 * 1024) {
                throw invalid();
            }
            var input = json.readValue(encoded, ManagedExtensionPackages.ImportMetadata.class);
            if (input == null || input.sourceKind() == null || !Set.of("skill", "extension", "mcp").contains(input.sourceKind())
                    || input.compilerVersion() != 1 || input.target() == null
                    || input.target().platform() == null || input.target().arch() == null
                    || !Set.of("linux", "darwin").contains(input.target().platform())
                    || !Set.of("x64", "arm64", "any").contains(input.target().arch())
                    || input.packageName() != null && !input.packageName().matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")) {
                throw invalid();
            }
            requireDigest(input.sourceDigest());
            return input;
        } catch (IOException | IllegalArgumentException error) {
            throw invalid();
        }
    }

    public Operation importPackage(String tenant, String actor, String workspace, String extensionId,
            String key, String encodedMetadata, InputStream source, long length) throws IOException {
        requireExecutionAccess(tenant, actor, workspace);
        requireSelfService();
        ManagedAgentService.validateIdempotencyKey(key);
        var input = decodeImportMetadata(encodedMetadata);
        if (extensionId != null) {
            requireId(extensionId);
            if (repository.list(tenant, workspace).stream().noneMatch(entry -> extensionId.equals(entry.pin().extensionId()))) {
                throw missing();
            }
        }
        if (length > ManagedExtensionPackages.MAX_ARCHIVE_BYTES) {
            throw new ManagedAgentException(413, "payload_too_large", "Extension input exceeds 100 MiB.");
        }
        requirePreparation();
        try (var prepared = prepareCall(() -> harness.preparePackage(envelope(tenant, actor, workspace, input), source))) {
            JsonNode descriptor = json.valueToTree(prepared.descriptor());
            String digest = descriptor.path("packageDigest").asText();
            requireDigest(digest);
            var manifest = decodeManifest(Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(json.writeValueAsBytes(descriptor.get("manifest"))));
            if (!input.target().equals(manifest.target())) {
                throw new ManagedAgentException(409, "package_target_mismatch", "Prepared package target differs.");
            }
            return publish(tenant, actor, workspace, extensionId, digest, key, manifest, prepared.archive());
        }
    }

    public JsonNode inspection(String tenant, String actor, String workspace, Pin pin) throws IOException {
        requireExecutionAccess(tenant, actor, workspace);
        requirePreparation();
        Package saved = get(tenant, actor, workspace, pin.extensionId(), pin.packageRevision(), pin.packageDigest());
        var input = new ManagedExtensionPackages.ImportMetadata("extension", saved.manifest().target(), pin.packageDigest(), 1, null);
        try (var lease = archive(tenant, actor, workspace, pin.extensionId(), pin.packageRevision(), pin.packageDigest());
                var source = Files.newInputStream(lease.path(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            JsonNode result = json.valueToTree(prepareCall(() -> harness.inspectPackage(envelope(tenant, actor, workspace, input), source)));
            if (!result.isObject() || !result.path("files").isArray() || result.path("files").size() > 256
                    || !result.path("fileCount").canConvertToInt() || result.path("fileCount").asInt() < result.path("files").size()
                    || !json.valueToTree(saved.manifest()).equals(result.path("manifest"))
                    || !result.path("skills").isArray() || !result.path("mcpServers").isArray() || !result.path("settings").isArray()) {
                throw new ManagedAgentException(409, "extension_inspection_invalid", "Package inspection could not be verified.");
            }
            return result;
        }
    }

    public JsonNode preview(String tenant, String actor, String workspace, String encodedMetadata,
            InputStream source, long length) {
        requireExecutionAccess(tenant, actor, workspace);
        requireSelfService();
        var input = decodeImportMetadata(encodedMetadata);
        requirePreparation();
        if (length > ManagedExtensionPackages.MAX_ARCHIVE_BYTES) {
            throw new ManagedAgentException(413, "payload_too_large", "Extension input exceeds 100 MiB.");
        }
        JsonNode result = json.valueToTree(prepareCall(() -> harness.previewPackage(envelope(tenant, actor, workspace, input), source)));
        if (!result.isObject() || !result.path("files").isArray() || result.path("files").size() > 256
                || !result.path("skills").isArray() || !result.path("mcpServers").isArray() || !result.path("settings").isArray()) {
            throw new ManagedAgentException(409, "extension_inspection_invalid", "Package preview could not be verified.");
        }
        return result;
    }

    private Map<String, Object> envelope(String tenant, String actor, String workspace, ManagedExtensionPackages.ImportMetadata input) {
        return Map.of("tenantId", tenant, "workspaceId", workspace, "actorKey", DigestUtils.sha256Hex(actor),
                "input", json.convertValue(input, json.getTypeFactory().constructMapType(java.util.LinkedHashMap.class, String.class, Object.class)));
    }

    private void requirePreparation() {
        if (!supportsPreparation()) {
            throw new ManagedAgentException(409, "unsupported_feature", "Managed package preparation is unavailable.");
        }
    }

    private <T> T prepareCall(java.util.function.Supplier<T> call) {
        try {
            return call.get();
        } catch (com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure error) {
            int status = error.getStatusCode();
            String code = error.getErrorCode();
            if (status >= 400 && status < 500 && code != null && code.matches("[a-z][a-z0-9_]{0,127}")) {
                throw new ManagedAgentException(status, code, "Managed package preparation was refused.");
            }
            throw new ManagedAgentException(503, "package_preparation_unavailable", "Managed package preparation is unavailable.");
        } catch (com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure error) {
            throw new ManagedAgentException(503, "package_preparation_unavailable", "Managed package preparation is unavailable.");
        }
    }

    public void requireExecutionAccess(String tenant, String actor, String workspace) {
        requireAccess(tenant, actor, workspace, true);
    }

    public void requireSelection(String tenant, String actor, String workspace, List<Pin> pins) {
        requireSelection(tenant, actor, workspace, pins, null);
    }

    private record AuthorizedSelection(String tenant, String actor, String workspace, List<Pin> pins,
            List<Package> packages, Instant deadline) implements Selection { }

    public Selection authorizeSelection(String tenant, String actor, String workspace, List<Pin> pins) {
        var saved = selection(tenant, actor, workspace, pins);
        for (Package entry : saved) {
            authorizeSource(tenant, actor, workspace, entry);
        }
        return new AuthorizedSelection(tenant, actor, workspace, List.copyOf(pins), saved, Instant.now().plusSeconds(120));
    }

    public void requireSelection(String tenant, String actor, String workspace, List<Pin> pins, Selection authorization) {
        var saved = selection(tenant, actor, workspace, pins);
        if (authorization instanceof AuthorizedSelection frozen && tenant.equals(frozen.tenant()) && actor.equals(frozen.actor())
                && workspace.equals(frozen.workspace()) && pins.equals(frozen.pins()) && saved.equals(frozen.packages())
                && Instant.now().isBefore(frozen.deadline())) {
            return;
        }
        if (authorization != null || saved.stream().anyMatch(entry -> entry.source() != null)) {
            throw new ManagedAgentException(409, "extension_selection_changed", "Authorize the complete extension selection before admission.");
        }
    }

    private List<Package> selection(String tenant, String actor, String workspace, List<Pin> pins) {
        requireExecutionAccess(tenant, actor, workspace);
        if (pins == null || pins.size() > 32 || pins.stream().anyMatch(java.util.Objects::isNull)
                || pins.stream().map(Pin::extensionId).distinct().count() != pins.size()) {
            throw invalid();
        }
        var saved = new java.util.ArrayList<Package>();
        for (Pin pin : pins) {
            saved.add(repository.get(tenant, workspace, pin));
            if (pin.settingsRevision() != null && !repository.hasSettings(tenant, workspace, pin)) {
                throw missing();
            }
        }
        return List.copyOf(saved);
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
        if (extensionId != null) {
            requireExecutionAccess(tenant, actor, workspace);
            Package previous = repository.list(tenant, workspace).stream()
                    .filter(entry -> extensionId.equals(entry.pin().extensionId())).findFirst().orElseThrow(ManagedExtensionPackageService::missing);
            if (previous.source() != null) {
                throw new ManagedAgentException(409, "extension_source_conflict", "Source-bound extensions require a source import.");
            }
            if (!previous.manifest().name().equals(manifest.name())) {
                throw new ManagedAgentException(409, "extension_namespace_conflict", "An update must retain the package namespace.");
            }
        }
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

    public Operation lookup(String tenant, String actor, String workspace, String kind, String key) {
        ManagedAgentService.validateIdempotencyKey(key);
        if (kind == null || !Set.of("publish", "settings", "source-import").contains(kind)) {
            throw invalid();
        }
        return operation(tenant, actor, workspace, operationId(tenant, actor, workspace, kind, key));
    }

    public Package get(String tenant, String actor, String workspace, String extensionId, long revision, String digest) {
        requireAccess(tenant, actor, workspace, false);
        Package saved = repository.get(tenant, workspace, new Pin(extensionId, revision, digest, null));
        authorizeSource(tenant, actor, workspace, saved);
        return saved;
    }

    public ExtensionArchives.Archive archive(String tenant, String actor, String workspace, String extensionId, long revision,
            String digest) throws IOException {
        Package saved = get(tenant, actor, workspace, extensionId, revision, digest);
        return archives.verify(tenant, workspace, digest, saved.byteLength());
    }

    public Settings settings(String tenant, String actor, String workspace, String extensionId) {
        authorizeExtension(tenant, actor, workspace, extensionId);
        return repository.settings(tenant, actor, workspace, extensionId,
                write -> requireAccess(tenant, actor, workspace, write));
    }

    public Operation saveSettings(String tenant, String actor, String workspace, String extensionId,
            String idempotencyKey, SettingsCommand command) {
        authorizeExtension(tenant, actor, workspace, extensionId);
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

    private void authorizeExtension(String tenant, String actor, String workspace, String extensionId) {
        requireAccess(tenant, actor, workspace, false);
        Package saved = repository.list(tenant, workspace).stream().filter(entry -> extensionId.equals(entry.pin().extensionId()))
                .findFirst().orElseThrow(ManagedExtensionPackageService::missing);
        authorizeSource(tenant, actor, workspace, saved);
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
