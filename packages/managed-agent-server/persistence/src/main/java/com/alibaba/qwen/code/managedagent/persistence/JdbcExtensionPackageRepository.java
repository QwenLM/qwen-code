package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Manifest;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Operation;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Package;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Settings;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.SettingsCommand;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ExtensionPackageRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.security.ProtectedSecret;
import com.alibaba.qwen.code.runtimebroker.security.SecretProtector;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

@org.springframework.stereotype.Repository
public class JdbcExtensionPackageRepository implements ExtensionPackageRepository {
    private static final TypeReference<Map<String, String>> SETTINGS = new TypeReference<>() { };
    private static final TypeReference<List<String>> KEYS = new TypeReference<>() { };
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ObjectMapper json;
    private final SecretProtector secrets;
    public JdbcExtensionPackageRepository(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json, ObjectProvider<SecretProtector> secrets) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.json = json;
        this.secrets = secrets.getIfAvailable();
    }
    public Operation preparePublish(String tenant, String actor, String workspace, String extensionId,
            String id, String digest, String operationId, String requestDigest, String encodedManifest, Access access) {
        return transaction.execute(status -> {
            lockWorkspace(tenant, actor, workspace, access);
            Operation existing = existingOperation(tenant, actor, workspace, operationId, requestDigest, access);
            if (existing != null) {
                return existing;
            }
            if (extensionId != null) {
                requireExtension(tenant, workspace, id);
            } else if (jdbc.queryForObject("SELECT COUNT(DISTINCT extension_id) FROM ma_extension_package WHERE scope_key = ?",
                    Long.class, scope(tenant, workspace)) >= 256) {
                throw new ManagedAgentException(409, "extension_catalog_too_large",
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
    }

    public Operation finishPublish(String tenant, String actor, String workspace, String id,
            String digest, String operationId, long length, Operation operation, Access access) {
        return transaction.execute(status -> {
            lockWorkspace(tenant, actor, workspace, access);
            jdbc.update("UPDATE ma_extension_package SET state = 'PUBLISHED', byte_length = ? WHERE package_key = ?",
                    length, packageKey(tenant, workspace, id, operation.revision()));
            jdbc.update("UPDATE ma_extension_operation SET state = 'settled' WHERE operation_key = ?",
                    operationKey(tenant, workspace, operationId));
            return new Operation(operationId, id, "publish", "settled", operation.revision(), digest);
        });
    }

    public Operation saveSettings(String tenant, String actor, String workspace, String extensionId,
            String operationId, String requestDigest, SettingsCommand command, byte[] plaintext, Access access) {
        return transaction.execute(status -> {
            lockWorkspace(tenant, actor, workspace, access);
            requireExtension(tenant, workspace, extensionId);
            Operation existing = existingOperation(tenant, actor, workspace, operationId, requestDigest, access);
            if (existing != null) {
                if (!settingsValues(tenant, workspace, extensionId, existing.revision()).equals(command.values())) {
                    throw new ManagedAgentException(409, "idempotency_conflict",
                            "The extension operation key was used for another request.");
                }
                return existing;
            }
            long current = settings(tenant, actor, workspace, extensionId, access).settingsRevision();
            if (command.expectedRevision() != current) {
                throw new ManagedAgentException(409, "extension_settings_revision_conflict",
                        "Extension settings changed. Refresh before applying settings.");
            }
            if (secrets == null) {
                throw new ManagedAgentException(409, "extension_settings_unavailable",
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

    public Operation operation(String tenant, String actor, String workspace, String operationId, Access access) {
        access.require(false);
        var rows = jdbc.query("SELECT extension_id, operation_kind, state, revision, package_digest"
                        + " FROM ma_extension_operation WHERE operation_key = ? AND actor_key = ?",
                (row, index) -> new Operation(operationId, row.getString(1), row.getString(2), row.getString(3),
                        row.getLong(4), row.getString(5)), operationKey(tenant, workspace, operationId), actorKey(tenant, actor));
        if (rows.size() != 1) {
            throw missing();
        }
        return rows.getFirst();
    }

    public Settings settings(String tenant, String actor, String workspace, String extensionId, Access access) {
        access.require(false);
        requireExtension(tenant, workspace, extensionId);
        var rows = jdbc.query("SELECT settings_revision, configured_keys_json FROM ma_extension_settings"
                        + " WHERE scope_key = ? AND extension_id = ? ORDER BY settings_revision DESC LIMIT 1",
                (row, index) -> new Settings(row.getLong(1), readKeys(row.getString(2))), scope(tenant, workspace), extensionId);
        return rows.isEmpty() ? new Settings(0, List.of()) : rows.getFirst();
    }

    public Map<String, String> settingsValues(String tenant, String workspace, String extensionId, long revision) {
        var rows = jdbc.query("SELECT encryption_key_id, encrypted_values FROM ma_extension_settings WHERE settings_key = ?",
                (row, index) -> new ProtectedSecret(row.getString(1), row.getString(2)), settingsKey(tenant, workspace, extensionId, revision));
        if (rows.size() != 1) {
            throw missing();
        }
        if (secrets == null) {
            throw new ManagedAgentException(409, "extension_settings_unavailable",
                    "Encrypted extension settings are unavailable.");
        }
        byte[] plaintext = secrets.unprotect(settingsContext(tenant, workspace, extensionId, revision), rows.getFirst());
        try {
            return Map.copyOf(json.readValue(plaintext, SETTINGS));
        } catch (IOException invalid) {
            throw new IllegalStateException("Invalid saved extension settings", invalid);
        }
    }

    private void lockWorkspace(String tenant, String actor, String workspace, Access access) {
        var states = jdbc.queryForList("SELECT state FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ? FOR UPDATE",
                String.class, tenant, workspace);
        access.require(true);
        if (states.size() != 1 || !"ACTIVE".equals(states.getFirst())) {
            throw new ManagedAgentException(409, "workspace_unavailable", "Workspace is not active.");
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

    private Operation existingOperation(String tenant, String actor, String workspace, String operationId, String digest, Access access) {
        var rows = jdbc.queryForList("SELECT request_digest FROM ma_extension_operation WHERE operation_key = ?",
                String.class, operationKey(tenant, workspace, operationId));
        if (rows.isEmpty()) {
            return null;
        }
        if (!digest.equals(rows.getFirst())) {
            throw new ManagedAgentException(409, "idempotency_conflict",
                    "The extension operation key was used for another request.");
        }
        return operation(tenant, actor, workspace, operationId, access);
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

    public Package get(String tenant, String workspace, Pin pin) {
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

    public List<Package> list(String tenant, String workspace) {
        var packages = jdbc.query("SELECT p.extension_id, p.package_revision, p.package_digest, p.manifest_json, p.byte_length"
                        + " FROM ma_extension_package p WHERE p.scope_key = ? AND p.state = 'PUBLISHED'"
                        + " AND p.package_revision = (SELECT MAX(v.package_revision) FROM ma_extension_package v"
                        + " WHERE v.scope_key = p.scope_key AND v.extension_id = p.extension_id AND v.state = 'PUBLISHED')"
                        + " ORDER BY extension_id, package_revision DESC LIMIT 257",
                (row, index) -> new Package(new Pin(row.getString(1), row.getLong(2), row.getString(3), null),
                        decode(row.getString(4), Manifest.class), row.getLong(5)), scope(tenant, workspace));
        if (packages.size() > 256) {
            throw new ManagedAgentException(409, "extension_catalog_too_large",
                    "The Workspace extension catalog exceeds 256 extensions.");
        }
        return packages;
    }

    public boolean hasSettings(String tenant, String workspace, Pin pin) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_settings WHERE settings_key = ?",
                Long.class, settingsKey(tenant, workspace, pin.extensionId(), pin.settingsRevision())) == 1;
    }
}
