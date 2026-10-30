package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackages.Catalog;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackages.Manifest;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackages.Operation;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackages.Package;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackages.Settings;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackages.SettingsCommand;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.security.ProtectedSecret;
import com.alibaba.qwen.code.runtimebroker.security.SecretProtector;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;

@Service
public class ManagedExtensionPackageService {
    private static final TypeReference<Map<String, String>> SETTINGS = new TypeReference<>() { };
    private static final TypeReference<List<String>> KEYS = new TypeReference<>() { };
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ManagedWorkspaceRegistry workspaces;
    private final ManagedAgentProperties properties;
    private final ManagedExtensionArchiveStore archives;
    private final ObjectMapper json;
    private final SecretProtector secrets;

    public ManagedExtensionPackageService(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc, @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager,
            ManagedWorkspaceRegistry workspaces, ManagedAgentProperties properties,
            ManagedExtensionArchiveStore archives, @Qualifier("managedAgentObjectMapper") ObjectMapper json, ObjectProvider<SecretProtector> secrets) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.workspaces = workspaces;
        this.properties = properties;
        this.archives = archives;
        this.json = json;
        this.secrets = secrets.getIfAvailable();
    }

    public Catalog list(String tenant, String actor, String workspace) {
        requireAccess(tenant, actor, workspace, false);
        var packages = jdbc.query("SELECT p.extension_id, p.package_revision, p.package_digest, p.manifest_json, p.byte_length"
                        + " FROM ma_extension_package p WHERE p.scope_key = ? AND p.state = 'PUBLISHED'"
                        + " AND p.package_revision = (SELECT MAX(v.package_revision) FROM ma_extension_package v"
                        + " WHERE v.scope_key = p.scope_key AND v.extension_id = p.extension_id AND v.state = 'PUBLISHED')"
                        + " ORDER BY extension_id, package_revision DESC LIMIT 257",
                (row, index) -> new Package(new Pin(row.getString(1), row.getLong(2), row.getString(3), null),
                        decode(row.getString(4), Manifest.class), row.getLong(5)), scope(tenant, workspace));
        if (packages.size() > 256) {
            throw new ManagedAgentException(HttpStatus.CONFLICT, "extension_catalog_too_large",
                    "The Workspace extension catalog exceeds 256 extensions.");
        }
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
            get(tenant, workspace, pin);
            if (pin.settingsRevision() != null && jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_settings WHERE settings_key = ?",
                    Long.class, settingsKey(tenant, workspace, pin.extensionId(), pin.settingsRevision())) != 1) {
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
        Operation operation = transaction.execute(status -> {
            lockWorkspace(tenant, actor, workspace);
            Operation existing = existingOperation(tenant, actor, workspace, operationId, requestDigest);
            if (existing != null) {
                return existing;
            }
            if (extensionId != null) {
                requireExtension(tenant, workspace, id);
            } else if (jdbc.queryForObject("SELECT COUNT(DISTINCT extension_id) FROM ma_extension_package WHERE scope_key = ?",
                    Long.class, scope(tenant, workspace)) >= 256) {
                throw new ManagedAgentException(HttpStatus.CONFLICT, "extension_catalog_too_large",
                        "The Workspace extension catalog is limited to 256 extensions.");
            }
            long revision = nextPackageRevision(tenant, workspace, id);
            jdbc.update("INSERT INTO ma_extension_package (package_key, scope_key, tenant_id, workspace_id, extension_id,"
                            + " package_revision, package_digest, manifest_json, byte_length, state, gmt_create)"
                            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'PREPARING', " + ManagedSchemaTime.SQL_NOW + ")",
                    packageKey(tenant, workspace, id, revision), scope(tenant, workspace), tenant, workspace, id, revision,
                    digest, encodedManifest);
            insertOperation(tenant, actor, workspace, operationId, id, "publish", revision, digest, requestDigest, "pending");
            return new Operation(operationId, id, "publish", "pending", revision, digest);
        });
        if ("settled".equals(operation.state())) {
            return operation;
        }
        long length = archives.put(tenant, workspace, digest, archive);
        return transaction.execute(status -> {
            lockWorkspace(tenant, actor, workspace);
            jdbc.update("UPDATE ma_extension_package SET state = 'PUBLISHED', byte_length = ? WHERE package_key = ?",
                    length, packageKey(tenant, workspace, id, operation.revision()));
            jdbc.update("UPDATE ma_extension_operation SET state = 'settled' WHERE operation_key = ?",
                    operationKey(tenant, workspace, operationId));
            return new Operation(operationId, id, "publish", "settled", operation.revision(), digest);
        });
    }

    public Operation operation(String tenant, String actor, String workspace, String operationId) {
        requireAccess(tenant, actor, workspace, false);
        var rows = jdbc.query("SELECT extension_id, operation_kind, state, revision, package_digest"
                        + " FROM ma_extension_operation WHERE operation_key = ? AND actor_key = ?",
                (row, index) -> new Operation(operationId, row.getString(1), row.getString(2), row.getString(3),
                        row.getLong(4), row.getString(5)), operationKey(tenant, workspace, operationId), actorKey(tenant, actor));
        if (rows.size() != 1) {
            throw missing();
        }
        return rows.getFirst();
    }

    public Package get(String tenant, String actor, String workspace, String extensionId, long revision, String digest) {
        requireAccess(tenant, actor, workspace, false);
        return get(tenant, workspace, new Pin(extensionId, revision, digest, null));
    }

    public Path archive(String tenant, String actor, String workspace, String extensionId, long revision,
            String digest) throws IOException {
        Package saved = get(tenant, actor, workspace, extensionId, revision, digest);
        return archives.verify(tenant, workspace, digest, saved.byteLength());
    }

    public Settings settings(String tenant, String actor, String workspace, String extensionId) {
        requireAccess(tenant, actor, workspace, false);
        requireExtension(tenant, workspace, extensionId);
        var rows = jdbc.query("SELECT settings_revision, configured_keys_json FROM ma_extension_settings"
                        + " WHERE scope_key = ? AND extension_id = ? ORDER BY settings_revision DESC LIMIT 1",
                (row, index) -> new Settings(row.getLong(1), readKeys(row.getString(2))), scope(tenant, workspace), extensionId);
        return rows.isEmpty() ? new Settings(0, List.of()) : rows.getFirst();
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
            throw new ManagedAgentException(HttpStatus.PAYLOAD_TOO_LARGE, "extension_settings_too_large",
                    "Extension settings exceed 8 KiB.");
        }
        String operationId = operationId(tenant, actor, workspace, "settings", idempotencyKey);
        String requestDigest = DigestUtils.sha256Hex(encode(List.of(extensionId, command.expectedRevision())));
        return transaction.execute(status -> {
            lockWorkspace(tenant, actor, workspace);
            requireExtension(tenant, workspace, extensionId);
            Operation existing = existingOperation(tenant, actor, workspace, operationId, requestDigest);
            if (existing != null) {
                if (!settingsValues(tenant, workspace, extensionId, existing.revision()).equals(command.values())) {
                    throw new ManagedAgentException(HttpStatus.CONFLICT, "idempotency_conflict",
                            "The extension operation key was used for another request.");
                }
                return existing;
            }
            long current = settings(tenant, actor, workspace, extensionId).settingsRevision();
            if (command.expectedRevision() != current) {
                throw new ManagedAgentException(HttpStatus.CONFLICT, "extension_settings_revision_conflict",
                        "Extension settings changed. Refresh before applying settings.");
            }
            if (secrets == null) {
                throw new ManagedAgentException(HttpStatus.CONFLICT, "extension_settings_unavailable",
                        "Encrypted extension settings are unavailable.");
            }
            long revision = current + 1;
            ProtectedSecret protectedValues = secrets.protect(settingsContext(tenant, workspace, extensionId, revision), plaintext);
            jdbc.update("INSERT INTO ma_extension_settings (settings_key, scope_key, tenant_id, workspace_id, extension_id,"
                            + " settings_revision, encryption_key_id, encrypted_values, configured_keys_json, gmt_create)"
                            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                    settingsKey(tenant, workspace, extensionId, revision), scope(tenant, workspace), tenant, workspace,
                    extensionId, revision, protectedValues.getKeyId(), protectedValues.getCiphertext(),
                    encode(new ArrayList<>(new TreeMap<>(command.values()).keySet())));
            insertOperation(tenant, actor, workspace, operationId, extensionId, "settings", revision, null,
                    requestDigest, "settled");
            return new Operation(operationId, extensionId, "settings", "settled", revision, null);
        });
    }

    public ResolvedPackage resolvePin(String tenant, String workspace, Pin pin) throws IOException {
        Package saved = get(tenant, workspace, pin);
        Map<String, String> settings = pin.settingsRevision() == null ? Map.of()
                : settingsValues(tenant, workspace, pin.extensionId(), pin.settingsRevision());
        return new ResolvedPackage(saved, archives.verify(tenant, workspace, pin.packageDigest(), saved.byteLength()), settings);
    }

    private Map<String, String> settingsValues(String tenant, String workspace, String extensionId, long revision) {
        var rows = jdbc.query("SELECT encryption_key_id, encrypted_values FROM ma_extension_settings WHERE settings_key = ?",
                (row, index) -> new ProtectedSecret(row.getString(1), row.getString(2)), settingsKey(tenant, workspace, extensionId, revision));
        if (rows.size() != 1) {
            throw missing();
        }
        if (secrets == null) {
            throw new ManagedAgentException(HttpStatus.CONFLICT, "extension_settings_unavailable",
                    "Encrypted extension settings are unavailable.");
        }
        byte[] plaintext = secrets.unprotect(settingsContext(tenant, workspace, extensionId, revision), rows.getFirst());
        try {
            return Map.copyOf(json.readValue(plaintext, SETTINGS));
        } catch (IOException invalid) {
            throw new IllegalStateException("Invalid saved extension settings", invalid);
        }
    }

    public record ResolvedPackage(Package descriptor, Path archive, Map<String, String> settings) {
        @Override
        public String toString() {
            return "ResolvedPackage[descriptor=" + descriptor + ", settings=redacted]";
        }
    }

    private Package get(String tenant, String workspace, Pin pin) {
        requireId(pin.extensionId());
        requireDigest(pin.packageDigest());
        if (pin.packageRevision() < 1 || pin.packageRevision() > 9_007_199_254_740_991L
                || pin.settingsRevision() != null && (pin.settingsRevision() < 1 || pin.settingsRevision() > 9_007_199_254_740_991L)) {
            throw invalid();
        }
        var rows = jdbc.query("SELECT manifest_json, byte_length FROM ma_extension_package WHERE package_key = ?"
                        + " AND package_digest = ? AND state = 'PUBLISHED'",
                (row, index) -> new Package(pin, decode(row.getString(1), Manifest.class), row.getLong(2)),
                packageKey(tenant, workspace, pin.extensionId(), pin.packageRevision()), pin.packageDigest());
        if (rows.size() != 1) {
            throw missing();
        }
        return rows.getFirst();
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
            throw new ManagedAgentException(HttpStatus.FORBIDDEN, "extension_management_forbidden",
                    "Extension management requires a Workspace operator and deployment permission.");
        }
    }

    private void lockWorkspace(String tenant, String actor, String workspace) {
        var states = jdbc.queryForList("SELECT state FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ? FOR UPDATE",
                String.class, tenant, workspace);
        requireAccess(tenant, actor, workspace, true);
        if (states.size() != 1 || !"ACTIVE".equals(states.getFirst())) {
            throw new ManagedAgentException(HttpStatus.CONFLICT, "workspace_unavailable", "Workspace is not active.");
        }
    }

    private void requireExtension(String tenant, String workspace, String extensionId) {
        requireId(extensionId);
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_package WHERE scope_key = ?"
                        + " AND extension_id = ? AND state = 'PUBLISHED'", Integer.class, scope(tenant, workspace), extensionId);
        if (count == null || count == 0) {
            throw missing();
        }
    }

    private long nextPackageRevision(String tenant, String workspace, String extensionId) {
        Long maximum = jdbc.queryForObject("SELECT COALESCE(MAX(package_revision), 0) FROM ma_extension_package"
                + " WHERE scope_key = ? AND extension_id = ?", Long.class, scope(tenant, workspace), extensionId);
        return (maximum == null ? 0 : maximum) + 1;
    }

    private Operation existingOperation(String tenant, String actor, String workspace, String operationId, String digest) {
        var rows = jdbc.queryForList("SELECT request_digest FROM ma_extension_operation WHERE operation_key = ?",
                String.class, operationKey(tenant, workspace, operationId));
        if (rows.isEmpty()) {
            return null;
        }
        if (!digest.equals(rows.getFirst())) {
            throw new ManagedAgentException(HttpStatus.CONFLICT, "idempotency_conflict",
                    "The extension operation key was used for another request.");
        }
        return operation(tenant, actor, workspace, operationId);
    }

    private void insertOperation(String tenant, String actor, String workspace, String operationId, String extensionId,
            String kind, long revision, String packageDigest, String requestDigest, String state) {
        jdbc.update("INSERT INTO ma_extension_operation (operation_key, scope_key, tenant_id, workspace_id, actor_key,"
                        + " operation_id, extension_id, operation_kind, revision, package_digest, request_digest, state, gmt_create)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                operationKey(tenant, workspace, operationId), scope(tenant, workspace), tenant, workspace, actorKey(tenant, actor),
                operationId, extensionId, kind, revision, packageDigest, requestDigest, state);
    }

    private String encode(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (IOException error) {
            throw new IllegalStateException("Cannot encode extension record", error);
        }
    }

    private <T> T decode(String value, Class<T> type) {
        try {
            return json.readValue(value, type);
        } catch (IOException error) {
            throw new IllegalStateException("Invalid saved extension record", error);
        }
    }

    private List<String> readKeys(String value) {
        try {
            return json.readValue(value, KEYS);
        } catch (IOException error) {
            throw new IllegalStateException("Invalid saved extension settings keys", error);
        }
    }

    private static String scope(String tenant, String workspace) { return ManagedSchemaKeys.key(tenant, workspace); }
    private static String actorKey(String tenant, String actor) { return ManagedSchemaKeys.key(tenant, actor); }
    private static String operationKey(String tenant, String workspace, String id) { return ManagedSchemaKeys.key(tenant, workspace, id); }
    private static String packageKey(String tenant, String workspace, String id, long revision) {
        return ManagedSchemaKeys.key(tenant, workspace, id, Long.toString(revision));
    }
    private static String settingsKey(String tenant, String workspace, String id, long revision) {
        return ManagedSchemaKeys.key("extension-settings", tenant, workspace, id, Long.toString(revision));
    }
    private static String settingsContext(String tenant, String workspace, String id, long revision) {
        return "managed-extension-settings:" + settingsKey(tenant, workspace, id, revision);
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
        return new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_request", "Invalid extension package request.");
    }
    private static ManagedAgentException missing() {
        return new ManagedAgentException(HttpStatus.NOT_FOUND, "extension_package_not_found", "Extension package was not found.");
    }
}
