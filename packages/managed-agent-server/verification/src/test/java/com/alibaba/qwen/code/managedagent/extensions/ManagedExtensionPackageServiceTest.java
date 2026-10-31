package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.adapters.extensions.ManagedExtensionArchiveStore;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Manifest;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.SettingsCommand;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Target;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedExtensionPackageServiceTest {
    @TempDir Path directory;
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private ManagedAgentProperties properties;
    private ManagedWorkspaceRegistry workspaces;
    private ManagedExtensionArchiveStore archives;
    private DefaultListableBeanFactory beans;
    private ManagedExtensionPackageService service;
    private final ObjectMapper json = new ObjectMapper();
    private final Manifest manifest = new Manifest(1, 1, "complete", "1.0.0",
            new Target("linux", "any"), List.of("skills", "settings"));
    private final byte[] bytes = "immutable archive bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8);

    @BeforeEach
    void setup() {
        var source = new DriverManagerDataSource("jdbc:h2:mem:extensions-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name,"
                + " config_ref, policy_ref, state) VALUES ('tenant', 'workspace', 1, 'storage', 'Workspace', 'config', 'policy', 'ACTIVE')");
        properties = new ManagedAgentProperties();
        properties.getExtensions().setEnabled(true);
        properties.getExtensions().setArtifactDirectory(directory.toString());
        properties.getExtensions().setAllowedActors(List.of("operator"));
        workspaces = mock(ManagedWorkspaceRegistry.class);
        when(workspaces.accessOf(anyString(), anyString(), anyString())).thenReturn(WorkspaceAccess.NONE);
        when(workspaces.accessOf("tenant", "operator", "workspace")).thenReturn(WorkspaceAccess.OPERATOR);
        when(workspaces.accessOf("tenant", "reader", "workspace")).thenReturn(WorkspaceAccess.READER);
        archives = new ManagedExtensionArchiveStore(properties);
        beans = new DefaultListableBeanFactory();
        beans.registerSingleton("secrets", new AesGcmSecretProtector("key", new byte[32]));
        service = service();
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
        var restored = service.resolvePin("tenant", "workspace", pin);
        assertThat(Files.readAllBytes(restored.archive())).isEqualTo(bytes);
        assertThat(restored.settings()).containsEntry("API_KEY", "private-value");
        assertThat(restored.toString()).doesNotContain("private-value");
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
        assertThat(service.resolvePin("tenant", "workspace",
                new Pin(publication.extensionId(), 1, digest, null)).settings()).isEmpty();
    }

    @Test
    void reservesOneStableIdentityAndRevisionAndResumesInterruptedUpload() throws Exception {
        String digest = DigestUtils.sha256Hex(bytes);
        InputStream interrupted = new InputStream() {
            @Override public int read() throws IOException { throw new IOException("interrupted"); }
        };
        assertThatThrownBy(() -> service.publish("tenant", "operator", "workspace", null, digest,
                "create", manifest, interrupted)).isInstanceOf(IOException.class);
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
        Files.writeString(restored.archive(), "changed archive");
        assertThatThrownBy(() -> service.resolvePin("tenant", "workspace", pin)).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo("extension_package_unavailable"));
    }

    @Test
    void validatesManifestWithoutResolvingHostEnvironment() throws Exception {
        String encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(json.writeValueAsBytes(manifest));
        assertThat(service.decodeManifest(encoded)).isEqualTo(manifest);
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
