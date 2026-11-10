package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.adapters.extensions.ManagedExtensionArchiveStore;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Manifest;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.SettingsCommand;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.SourceImport;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Target;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionSource;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.security.SecretProtector;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ManagedExtensionPackageServiceTest {
    @TempDir Path directory;
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private ManagedAgentProperties properties;
    private JdbcManagedWorkspaceRegistry workspaces;
    private ManagedExtensionArchiveStore archives;
    private DefaultListableBeanFactory beans;
    private ManagedExtensionPackageService service;
    private final ObjectMapper json = new ObjectMapper();
    private final Manifest manifest = new Manifest(1, 1, "complete", "1.0.0",
            new Target("linux", "any"), List.of("skills", "settings"));
    private final byte[] bytes = "immutable archive bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8);

    @BeforeEach
    void setup() {
        var source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name,"
                + " config_ref, policy_ref, state) VALUES ('tenant', 'workspace', 1, 'storage', 'Workspace', 'config', 'policy', 'ACTIVE')");
        properties = new ManagedAgentProperties();
        properties.getExtensions().setEnabled(true);
        properties.getExtensions().setSelfServiceEnabled(true);
        properties.getExtensions().setArtifactDirectory(directory.toString());
        properties.getExtensions().setAllowedActors(List.of("operator"));
        workspaces = mock(JdbcManagedWorkspaceRegistry.class);
        when(workspaces.accessOf(anyString(), anyString(), anyString())).thenReturn(WorkspaceAccess.NONE);
        when(workspaces.accessOf("tenant", "operator", "workspace")).thenReturn(WorkspaceAccess.OPERATOR);
        when(workspaces.accessOf("tenant", "reader", "workspace")).thenReturn(WorkspaceAccess.READER);
        archives = new ManagedExtensionArchiveStore(properties);
        beans = new DefaultListableBeanFactory();
        beans.registerSingleton("secrets", new AesGcmSecretProtector("key", new byte[32]));
        service = service();
    }

    protected javax.sql.DataSource dataSource() {
        return new DriverManagerDataSource("jdbc:h2:mem:extensions-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    @Test
    void duplicateProviderIdsRefuseStartup() {
        var first = mock(ManagedExtensionSource.class);
        var second = mock(ManagedExtensionSource.class);
        when(first.id()).thenReturn("business");
        when(second.id()).thenReturn("business");
        assertThatThrownBy(() -> service.configureSources(List.of(first, second))).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void pendingPublicationKeepsItsNamespaceAndRecoversUnknownStorageOutcome() throws Exception {
        sourceProvider();
        var command = new SourceImport(new ManagedExtensionSource.Reference("business", "skill", "skill_1", "1"), manifest.target());
        var imported = service.importSource("tenant", "operator", "workspace", "source", command);
        jdbc.update("UPDATE ma_extension_package SET state='PREPARING', byte_length=0");
        jdbc.update("UPDATE ma_extension_operation SET state='pending'");
        var pending = service.lookupSourceImport("tenant", "operator", "workspace", "source");
        assertThat(pending.state()).isEqualTo("pending");
        assertThat(pending.pin()).isNull();
        assertThat(pending.source()).isEqualTo(imported.source());
        var preparation = mock(HarnessConnector.class);
        when(preparation.supportsPackagePreparation()).thenReturn(true);
        var changed = new Manifest(1, 1, "another-name", "1.0", manifest.target(), manifest.components());
        when(preparation.preparePackage(anyMap(), any())).thenAnswer(call -> new HarnessConnector.PreparedPackage(
                Map.of("manifest", json.convertValue(changed, Map.class), "packageDigest", DigestUtils.sha256Hex(bytes)), new ByteArrayInputStream(bytes)));
        service.configurePreparation(preparation);
        assertThatThrownBy(() -> service.importSource("tenant", "operator", "workspace", "v2",
                new SourceImport(new ManagedExtensionSource.Reference("business", "skill", "skill_1", "2"), manifest.target())))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("extension_namespace_conflict"));
        sourceProvider();
        assertThat(service.importSource("tenant", "operator", "workspace", "source", command)).isEqualTo(imported);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_package", Integer.class)).isEqualTo(1);
    }

    @Test
    void keepsAdmittedContentAndReceiptsAfterSourceRevocationAndProviderRestart() throws Exception {
        var provider = sourceProvider();
        var command = new SourceImport(new ManagedExtensionSource.Reference("business", "skill", "skill_1", "1"), manifest.target());
        var imported = service.importSource("tenant", "operator", "workspace", "source", command);
        assertThat(imported.source().sourceDigest()).isEqualTo(DigestUtils.sha256Hex("source-1"));
        assertThat(imported.pin().packageDigest()).isEqualTo(DigestUtils.sha256Hex(bytes));
        var frozen = service.authorizeSelection("tenant", "operator", "workspace", List.of(imported.pin()));
        org.mockito.Mockito.doThrow(new ManagedExtensionSource.Failure(ManagedExtensionSource.Failure.Reason.NOT_FOUND, null)).when(provider).resolve(any(), any());
        assertThat(service.list("tenant", "reader", "workspace").extensions()).isEmpty();
        assertThatThrownBy(() -> service.get("tenant", "reader", "workspace", imported.pin().extensionId(), 1, imported.pin().packageDigest()))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getStatus()).isEqualTo(404));
        assertThatThrownBy(() -> service.archive("tenant", "reader", "workspace", imported.pin().extensionId(), 1, imported.pin().packageDigest()))
                .isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> service.settings("tenant", "reader", "workspace", imported.pin().extensionId())).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> service.saveSettings("tenant", "operator", "workspace", imported.pin().extensionId(), "settings", new SettingsCommand(0, Map.of())))
                .isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> service.authorizeSelection("tenant", "operator", "workspace", List.of(imported.pin())))
                .isInstanceOf(ManagedAgentException.class);
        service.requireSelection("tenant", "operator", "workspace", List.of(imported.pin()), frozen);
        assertThatThrownBy(() -> service.requireSelection("tenant", "operator", "workspace", List.of(imported.pin())))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("extension_selection_changed"));
        service = service();
        assertThat(service.importSource("tenant", "operator", "workspace", "source", command)).isEqualTo(imported);
        assertThat(service.lookupSourceImport("tenant", "operator", "workspace", "source")).isEqualTo(imported);
        try (var restored = service.resolvePin("tenant", "workspace", imported.pin())) {
            assertThat(Files.readAllBytes(restored.archive())).isEqualTo(bytes);
            assertThat(restored.descriptor().source()).isEqualTo(imported.source());
        }
        assertThatThrownBy(() -> service.publish("tenant", "operator", "workspace", imported.pin().extensionId(), imported.pin().packageDigest(),
                "binary-overwrite", manifest, new ByteArrayInputStream(bytes)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("extension_source_conflict"));
        assertThatThrownBy(() -> service.lookupSourceImport("tenant", "reader", "workspace", "source")).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void retainsIntentBeforeSourceFailureAndRejectsChangedKeysAndRevisionBytes() throws Exception {
        var provider = sourceProvider();
        var reference = new ManagedExtensionSource.Reference("business", "extension", "suite_1", "1");
        var command = new SourceImport(reference, manifest.target());
        org.mockito.Mockito.doThrow(new IOException("OSS unavailable")).when(provider).open(any(), any());
        assertThatThrownBy(() -> service.importSource("tenant", "operator", "workspace", "source", command))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(503);
                    assertThat(error.getCode()).isEqualTo("extension_source_unavailable");
                });
        var pending = service.lookupSourceImport("tenant", "operator", "workspace", "source");
        assertThat(pending.state()).isEqualTo("pending");
        assertThat(pending.pin()).isNull();
        assertThat(pending.reference()).isEqualTo(reference);
        assertThatThrownBy(() -> service.importSource("tenant", "operator", "workspace", "source",
                new SourceImport(reference, new Target("darwin", "any"))))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        org.mockito.Mockito.doAnswer(call -> new ByteArrayInputStream("source-1".getBytes(StandardCharsets.UTF_8))).when(provider).open(any(), any());
        var first = service.importSource("tenant", "operator", "workspace", "source", command);
        var second = service.importSource("tenant", "operator", "workspace", "v2",
                new SourceImport(new ManagedExtensionSource.Reference("business", "extension", "suite_1", "2"), manifest.target()));
        assertThat(second.pin().extensionId()).isEqualTo(first.pin().extensionId());
        assertThat(second.pin().packageRevision()).isEqualTo(2);
        org.mockito.Mockito.doAnswer(call -> new ByteArrayInputStream("different".getBytes(StandardCharsets.UTF_8))).when(provider).open(any(), any());
        assertThatThrownBy(() -> service.importSource("tenant", "operator", "workspace", "drift", command))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("extension_source_conflict"));
        jdbc.update("UPDATE ma_extension_package SET source_json = 'null'");
        assertThatThrownBy(() -> service.resolvePin("tenant", "workspace", first.pin())).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void concurrentImportsReserveOnePublicationAndNeverCallBusinessInSqlTransaction() throws Exception {
        sourceProvider();
        var command = new SourceImport(new ManagedExtensionSource.Reference("business", "skill", "skill_1", "1"), manifest.target());
        try (var executor = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var left = executor.submit(() -> service.importSource("tenant", "operator", "workspace", "source", command));
            var right = executor.submit(() -> service.importSource("tenant", "operator", "workspace", "source", command));
            assertThat(left.get(15, java.util.concurrent.TimeUnit.SECONDS)).isEqualTo(right.get(15, java.util.concurrent.TimeUnit.SECONDS));
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_source_import", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_package", Integer.class)).isEqualTo(1);
    }

    private ManagedExtensionSource sourceProvider() throws Exception {
        var provider = mock(ManagedExtensionSource.class);
        when(provider.id()).thenReturn("business");
        when(provider.resolve(any(), any())).thenAnswer(call -> {
            assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            ManagedExtensionSource.Context context = call.getArgument(0);
            assertThat(context.tenantId()).isEqualTo("tenant");
            assertThat(context.workspaceId()).isEqualTo("workspace");
            return new ManagedExtensionSource.Resolved(call.getArgument(1), "private/object", null);
        });
        when(provider.open(any(), any())).thenAnswer(call -> {
            assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            ManagedExtensionSource.Resolved selected = call.getArgument(1);
            return new ByteArrayInputStream(("source-" + selected.reference().revision()).getBytes(StandardCharsets.UTF_8));
        });
        service.configureSources(List.of(provider));
        var harness = mock(HarnessConnector.class);
        when(harness.supportsPackagePreparation()).thenReturn(true);
        when(harness.preparePackage(anyMap(), any())).thenAnswer(call -> new HarnessConnector.PreparedPackage(
                Map.of("manifest", json.convertValue(manifest, Map.class), "packageDigest", DigestUtils.sha256Hex(bytes)), new ByteArrayInputStream(bytes)));
        service.configurePreparation(harness);
        return provider;
    }

    @Test
    void importsWithoutSessionAndLooksUpTheSameDurableReceipt() throws Exception {
        var harness = mock(HarnessConnector.class);
        when(harness.supportsPackagePreparation()).thenReturn(true);
        String digest = DigestUtils.sha256Hex(bytes);
        when(harness.preparePackage(anyMap(), any())).thenAnswer(call -> new HarnessConnector.PreparedPackage(
                Map.of("manifest", json.convertValue(manifest, Map.class), "packageDigest", digest), new ByteArrayInputStream(bytes)));
        service.configurePreparation(harness);
        String metadata = "{\"sourceKind\":\"skill\",\"target\":{\"platform\":\"linux\",\"arch\":\"any\"},"
                + "\"sourceDigest\":\"" + digest + "\",\"compilerVersion\":1}";
        var imported = service.importPackage("tenant", "operator", "workspace", null, "install", metadata,
                new ByteArrayInputStream(bytes), bytes.length);
        assertThat(service.lookup("tenant", "operator", "workspace", "publish", "install")).isEqualTo(imported);
        assertThat(service.importPackage("tenant", "operator", "workspace", null, "install", metadata,
                new ByteArrayInputStream(bytes), bytes.length)).isEqualTo(imported);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_package", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Integer.class)).isZero();
        assertThat(service.list("tenant", "operator", "workspace").selfService().canPublish()).isTrue();
        assertThat(service.list("tenant", "reader", "workspace").selfService().canPublish()).isFalse();
        assertThatThrownBy(() -> service.lookup("tenant", "reader", "workspace", "publish", "install"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getStatus()).isEqualTo(404));
    }

    @Test
    void rejectsUntrustedImportMetadataAndDoesNotConsumeDeniedInput() {
        assertThatThrownBy(() -> service.decodeImportMetadata("{\"sourceKind\":null}"))
                .isInstanceOf(ManagedAgentException.class);
        String metadata = "{\"sourceKind\":\"skill\",\"target\":{\"platform\":\"linux\",\"arch\":\"any\"},"
                + "\"sourceDigest\":\"" + "a".repeat(64) + "\",\"compilerVersion\":1,\"actorKey\":\"forged\"}";
        assertThatThrownBy(() -> service.decodeImportMetadata(metadata)).isInstanceOf(ManagedAgentException.class);
        var input = new ByteArrayInputStream(bytes);
        assertThatThrownBy(() -> service.importPackage("tenant", "reader", "workspace", null, "install", metadata,
                input, bytes.length)).isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(403));
        assertThat(input.available()).isEqualTo(bytes.length);
    }

    @Test
    void requiresWritePermissionBeforeLookingUpSettingsOrConsultingSource() throws Exception {
        var provider = sourceProvider();
        var imported = service.importSource("tenant", "operator", "workspace", "source",
                new SourceImport(new ManagedExtensionSource.Reference("business", "skill", "skill_1", "1"), manifest.target()));
        clearInvocations(provider);
        var command = new SettingsCommand(0, Map.of());
        for (String extensionId : List.of(imported.pin().extensionId(), "ext_11111111-1111-4111-8111-111111111111")) {
            assertThatThrownBy(() -> service.saveSettings("tenant", "reader", "workspace", extensionId, "settings", command))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                        assertThat(error.getStatus()).isEqualTo(403);
                        assertThat(error.getCode()).isEqualTo("extension_management_forbidden");
                    });
        }
        verifyNoInteractions(provider);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_settings", Integer.class)).isZero();
    }

    @Test
    void keepsFullArchiveAndEncryptedSettingsAcrossControlPlaneRestart() throws Exception {
        String digest = DigestUtils.sha256Hex(bytes);
        var publication = service.publish("tenant", "operator", "workspace", null, digest,
                "create", manifest, new ByteArrayInputStream(bytes));
        assertThat(publication.state()).isEqualTo("settled");
        var configured = service.saveSettings("tenant", "operator", "workspace", publication.extensionId(), "settings",
                new SettingsCommand(0, Map.of("API_KEY", "private-value", "REGION", "test")));
        assertThat(configured.revision()).isEqualTo(1);
        assertThat(service.saveSettings("tenant", "operator", "workspace", publication.extensionId(), "settings",
                new SettingsCommand(0, Map.of("API_KEY", "private-value", "REGION", "test")))).isEqualTo(configured);
        assertThatThrownBy(() -> service.saveSettings("tenant", "operator", "workspace", publication.extensionId(), "settings",
                new SettingsCommand(0, Map.of("API_KEY", "changed-value", "REGION", "test"))))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        assertThat(jdbc.queryForObject("SELECT encrypted_values FROM ma_extension_settings", String.class))
                .doesNotContain("private-value");
        service = service();
        var pin = new Pin(publication.extensionId(), 1, digest, 1L);
        try (var restored = service.resolvePin("tenant", "workspace", pin)) {
            assertThat(Files.readAllBytes(restored.archive())).isEqualTo(bytes);
            assertThat(restored.settings()).containsEntry("API_KEY", "private-value");
            assertThat(restored.toString()).doesNotContain("private-value");
        }
        assertThat(json.writeValueAsString(service.settings("tenant", "reader", "workspace", publication.extensionId())))
                .contains("API_KEY").doesNotContain("private-value");
        assertThat(service.list("tenant", "reader", "workspace").extensions()).hasSize(1);
    }

    @Test
    void distinguishesUnavailableEncryptionFromMissingSettingsAfterRestart() throws Exception {
        String digest = DigestUtils.sha256Hex(bytes);
        var publication = service.publish("tenant", "operator", "workspace", null, digest,
                "create", manifest, new ByteArrayInputStream(bytes));
        var command = new SettingsCommand(0, Map.of("API_KEY", "private-value"));
        service.saveSettings("tenant", "operator", "workspace", publication.extensionId(), "settings", command);
        beans.destroySingleton("secrets");
        service = service();
        var pin = new Pin(publication.extensionId(), 1, digest, 1L);
        assertThatThrownBy(() -> service.resolvePin("tenant", "workspace", pin))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode()).isEqualTo("extension_settings_unavailable");
                });
        assertThatThrownBy(() -> service.saveSettings("tenant", "operator", "workspace",
                publication.extensionId(), "settings", command))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode()).isEqualTo("extension_settings_unavailable");
                });
        assertThatThrownBy(() -> service.resolvePin("tenant", "workspace",
                new Pin(publication.extensionId(), 1, digest, 2L)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(404);
                    assertThat(error.getCode()).isEqualTo("extension_package_not_found");
                });
        try (var restored = service.resolvePin("tenant", "workspace", new Pin(publication.extensionId(), 1, digest, null))) {
            assertThat(restored.settings()).isEmpty();
        }
    }

    @Test
    void reservesOneStableIdentityAndRevisionAndResumesInterruptedUpload() throws Exception {
        String digest = DigestUtils.sha256Hex(bytes);
        InputStream interrupted = new InputStream() {
            @Override public int read() throws IOException { throw new IOException("interrupted"); }
        };
        assertThatThrownBy(() -> service.publish("tenant", "operator", "workspace", null, digest,
                "create", manifest, interrupted)).isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(503);
                    assertThat(error.getCode()).isEqualTo("extension_package_unavailable");
                });
        assertThat(jdbc.queryForObject("SELECT state FROM ma_extension_operation", String.class)).isEqualTo("pending");
        assertThat(service.list("tenant", "reader", "workspace").extensions()).isEmpty();
        var resumed = service.publish("tenant", "operator", "workspace", null, digest,
                "create", manifest, new ByteArrayInputStream(bytes));
        assertThat(resumed.revision()).isEqualTo(1);
        assertThat(service.publish("tenant", "operator", "workspace", null, digest,
                "create", manifest, InputStream.nullInputStream())).isEqualTo(resumed);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_package", Integer.class)).isEqualTo(1);
        assertThatThrownBy(() -> service.publish("tenant", "operator", "workspace", null, "a".repeat(64),
                "create", manifest, new ByteArrayInputStream(bytes))).isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
    }

    @Test
    void requiresDeploymentPermissionInAdditionToOperatorAndDoesNotConsumeDeniedUpload() {
        var stream = new ByteArrayInputStream(bytes);
        assertThatThrownBy(() -> service.publish("tenant", "reader", "workspace", null, DigestUtils.sha256Hex(bytes),
                "create", manifest, stream)).isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("extension_management_forbidden"));
        assertThat(stream.available()).isEqualTo(bytes.length);
        properties.getExtensions().setAllowedActors(List.of());
        assertThatThrownBy(() -> service.publish("tenant", "operator", "workspace", null, DigestUtils.sha256Hex(bytes),
                "create", manifest, stream)).isInstanceOf(ManagedAgentException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_operation", Integer.class)).isZero();
        assertThatThrownBy(() -> service.list("other-tenant", "operator", "workspace")).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void rejectsSettingsRevisionConflictsCrossScopePinsAndArchiveDrift() throws Exception {
        String digest = DigestUtils.sha256Hex(bytes);
        var published = service.publish("tenant", "operator", "workspace", null, digest,
                "create", manifest, new ByteArrayInputStream(bytes));
        service.saveSettings("tenant", "operator", "workspace", published.extensionId(), "settings",
                new SettingsCommand(0, Map.of("API_KEY", "secret")));
        assertThatThrownBy(() -> service.saveSettings("tenant", "operator", "workspace", published.extensionId(), "stale",
                new SettingsCommand(0, Map.of("API_KEY", "next"))))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("extension_settings_revision_conflict"));
        var pin = new Pin(published.extensionId(), 1, digest, 1L);
        assertThatThrownBy(() -> service.resolvePin("other-tenant", "workspace", pin)).isInstanceOf(ManagedAgentException.class);
        var restored = service.resolvePin("tenant", "workspace", pin);
        restored.close();
        Files.writeString(directory.resolve(com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key("tenant", "workspace"))
                .resolve(digest + ".tar.gz"), "changed archive");
        assertThatThrownBy(() -> service.resolvePin("tenant", "workspace", pin)).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo("extension_package_unavailable"));
    }

    @Test
    void validatesManifestWithoutResolvingHostEnvironment() throws Exception {
        String encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(json.writeValueAsBytes(manifest));
        assertThat(service.decodeManifest(encoded)).isEqualTo(manifest);
        var mixedVersion = new Manifest(1, 2, "mixed", "1.0.0", new Target("linux", "any"), List.of("mcp"));
        assertThatThrownBy(() -> service.decodeManifest(Base64.getUrlEncoder().withoutPadding().encodeToString(json.writeValueAsBytes(mixedVersion))))
                .isInstanceOf(ManagedAgentException.class);
        String invalid = Base64.getUrlEncoder().withoutPadding().encodeToString(json.writeValueAsBytes(Map.of(
                "schemaVersion", 1, "compilerVersion", 1, "name", "complete", "version", "1.0",
                "target", Map.of("platform", "windows", "arch", "x64"), "components", List.of("skills"))));
        assertThatThrownBy(() -> service.decodeManifest(invalid)).isInstanceOf(ManagedAgentException.class);
        assertThat(new SettingsCommand(0, Map.of("API_KEY", "private-value")).toString()).doesNotContain("private-value");
    }

    private ManagedExtensionPackageService service() {
        return new ManagedExtensionPackageService(new com.alibaba.qwen.code.managedagent.persistence.JdbcExtensionPackageRepository(
                jdbc, manager, json, beans.getBeanProvider(SecretProtector.class)), workspaces, properties, archives, json);
    }
}
