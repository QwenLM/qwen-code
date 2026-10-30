package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Clock;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

class SharedLocalProjectsTest {
    @TempDir
    Path temp;

    protected DataSource dataSource() {
        return new DriverManagerDataSource("jdbc:h2:mem:shared-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    private Catalog catalog(String name) throws Exception {
        Path home = Files.createDirectory(temp.resolve(name)).toRealPath();
        var properties = new ManagedAgentProperties();
        var broker = properties.getRuntimeBroker();
        broker.setVerifiedWorkspaceRecoveryEnabled(true);
        broker.setLocalDirectoryImportEnabled(true);
        broker.setStateDirectory(Files.createDirectory(home.resolve("runtime")).toString());
        broker.setWorkspaceCreationRoot(Files.createDirectory(home.resolve("workspaces")).toString());
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        JdbcTemplate jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var guard = new WorkspaceStorageGuard(jdbc, manager, properties,
                path -> new WorkspaceStorageGuard.Identity(path.toString(), "test-host", "device",
                        Files.readAttributes(path, BasicFileAttributes.class).fileKey().toString(), "birth"));
        var store = new WorkspaceCreationStore(jdbc, manager, guard, new ManagedWorkspaceRegistry(jdbc),
                properties, new ObjectMapper(), Clock.systemUTC());
        return new Catalog(name, jdbc, manager, properties, guard, store);
    }

    private Path project() throws Exception {
        Path project = Files.createDirectories(temp.resolve("projects/project")).toRealPath();
        Files.createDirectory(project.resolve(".git"));
        Files.writeString(project.resolve("kept.txt"), "user content\n");
        return project;
    }

    private record Catalog(String tenant, JdbcTemplate jdbc, DataSourceTransactionManager manager,
            ManagedAgentProperties properties, WorkspaceStorageGuard guard, WorkspaceCreationStore store) {
        ManagedWorkspaceRegistry.WorkspaceSummary add(Path project) {
            return store.create(tenant, "actor", "Project", "import", null, null, project.toString());
        }

        String storage(ManagedWorkspaceRegistry.WorkspaceSummary workspace) {
            return jdbc.queryForObject("SELECT storage_id FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?",
                    String.class, tenant, workspace.workspaceId());
        }

        ContextBinding binding(ManagedWorkspaceRegistry.WorkspaceSummary workspace) {
            return new ContextBinding(tenant, workspace.workspaceId(), 1, storage(workspace),
                    workspace.defaultCwdRelative(), "config", 1);
        }

        Path marker(ManagedWorkspaceRegistry.WorkspaceSummary workspace) {
            return Path.of(properties.getRuntimeBroker().getStateDirectory()).resolve("imported-projects")
                    .resolve(storage(workspace)).resolve(".qwen-managed-storage.json");
        }
    }

    @Test
    void independentCatalogsShareProjectWithoutChangingForeignMarker() throws Exception {
        Path project = project();
        Path foreign = project.getParent().resolve(".qwen-managed-storage.json");
        Files.writeString(foreign, "foreign registration\n");
        Catalog first = catalog("first");
        Catalog second = catalog("second");
        var a = first.add(project);
        var b = second.add(project);
        assertThat(a.canCreateSession()).isTrue();
        assertThat(b.canCreateSession()).isTrue();
        first.guard().verify(first.binding(a));
        second.guard().verify(second.binding(b));
        assertThat(first.guard().fileRoot(first.binding(a)).get("root")).isEqualTo(project.getParent().toString());
        assertThat(second.guard().fileRoot(second.binding(b)).get("root")).isEqualTo(project.getParent().toString());
        assertThat(first.add(project)).isEqualTo(a);
        assertThat(second.add(project)).isEqualTo(b);
        assertThat(Files.readString(foreign)).isEqualTo("foreign registration\n");
        assertThat(Files.readString(project.resolve("kept.txt"))).isEqualTo("user content\n");
        assertThat(first.marker(a)).isNotEqualTo(second.marker(b));
        assertThat(Files.exists(first.marker(a))).isTrue();
        assertThat(Files.exists(second.marker(b))).isTrue();
    }

    @Test
    void privateMetadataLossBlocksOnlyItsOwnCatalog() throws Exception {
        Path project = project();
        Catalog first = catalog("first");
        Catalog second = catalog("second");
        var a = first.add(project);
        var b = second.add(project);
        Files.delete(first.marker(a));
        assertThatThrownBy(() -> first.guard().verify(first.binding(a))).isInstanceOf(RuntimeBrokerException.class);
        assertThat(first.add(project)).isEqualTo(a);
        assertThat(Files.exists(first.marker(a))).isFalse();
        second.guard().verify(second.binding(b));
        Files.writeString(second.marker(b), "{}");
        assertThatThrownBy(() -> second.guard().verify(second.binding(b))).isInstanceOf(RuntimeBrokerException.class);
        assertThat(Files.exists(project.getParent().resolve(".qwen-managed-storage.json"))).isFalse();
    }

    @Test
    void sourceReplacementIsStillRefusedWithIntactPrivateMetadata() throws Exception {
        Path project = project();
        Catalog catalog = catalog("first");
        var imported = catalog.add(project);
        Files.move(project.getParent(), temp.resolve("saved-projects"));
        Files.createDirectories(project);
        assertThat(Files.exists(catalog.marker(imported))).isTrue();
        assertThatThrownBy(() -> catalog.guard().verify(catalog.binding(imported))).isInstanceOf(RuntimeBrokerException.class);
    }

    @Test
    void sharedRootRejectsExclusiveMaintenanceBeforeChangingState() throws Exception {
        Path project = project();
        Catalog catalog = catalog("first");
        var imported = catalog.add(project);
        String storage = catalog.storage(imported);
        String operation = UUID.randomUUID().toString();
        var registration = new WorkspaceStorageGuard.RecoveryRegistration(catalog.tenant(), storage,
                operation, 1, operation, project.getParent().toString(), "host", "device", "inode", "birth");
        List<Runnable> exclusive = List.of(
                () -> catalog.guard().fence(catalog.tenant(), storage, 1, operation),
                () -> catalog.guard().restoreOriginal(catalog.tenant(), storage, 1, operation),
                () -> catalog.guard().recoveryRegistration(catalog.tenant(), storage, 1, operation),
                () -> catalog.guard().verifyCapturedRegistration(registration),
                () -> catalog.guard().migrationSource(catalog.tenant(), storage, 1, operation),
                () -> catalog.guard().publishMigrationMarker(project.getParent(), new byte[0], registration, operation),
                () -> catalog.guard().promoteMigration(registration, catalog.guard().identity(project.getParent()), operation, operation),
                () -> new WorkspaceExecutionStore(catalog.jdbc(), catalog.manager(), catalog.guard(), catalog.properties())
                        .beginRewind(catalog.binding(imported), mock(RuntimeSessionRecord.class)));
        for (Runnable action : exclusive) {
            assertThatThrownBy(action::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                    error -> assertThat(error.getCode()).isEqualTo("workspace_shared_directory"));
        }
        assertThat(catalog.jdbc().queryForObject("SELECT mount_state FROM ma_storage_owner", String.class)).isEqualTo("READY");
        assertThat(catalog.jdbc().queryForObject("SELECT COUNT(*) FROM ma_operation", Integer.class)).isZero();
        assertThat(Files.readString(project.resolve("kept.txt"))).isEqualTo("user content\n");
    }

    @Test
    void legacyImportedReceiptKeepsItsOriginalMarkerContract() throws Exception {
        Path project = project();
        Catalog legacy = catalog("legacy");
        byte[] actor = ManagedWorkspaceRegistry.actorKey(legacy.tenant(), "actor");
        String scope = ManagedReceipts.actorScope(actor);
        String key = ManagedSchemaKeys.receiptKey(ReceiptNamespace.WORKSPACE_CREATE,
                legacy.tenant(), ReceiptScope.ACTOR, scope, "import");
        String digest = ManagedSchemaKeys.key("local-directory-import/1", "Project", project.toString());
        var details = new WorkspaceCreationRoots.Details("workspace-" + key, "created-" + key,
                "Project", UUID.randomUUID().toString(), null, null, "project", legacy.guard().identity(project.getParent()));
        String encoded = new ObjectMapper().writeValueAsString(details);
        new TransactionTemplate(legacy.manager()).executeWithoutResult(status -> {
            ManagedReceipts.insert(legacy.jdbc(), ReceiptNamespace.WORKSPACE_CREATE, legacy.tenant(),
                        ReceiptScope.ACTOR, scope, "import", digest, "CREATE_WORKSPACE", actor,
                        null, null, "PENDING", null, null, Clock.systemUTC().millis());
            legacy.jdbc().update("UPDATE ma_request_receipt SET result_json = ? WHERE receipt_key = ?", encoded, key);
        });
        var resumed = legacy.add(project);
        Path marker = project.getParent().resolve(".qwen-managed-storage.json");
        String original = Files.readString(marker);
        assertThat(legacy.storage(resumed)).startsWith("created-");
        var shared = catalog("shared");
        assertThat(shared.add(project).canCreateSession()).isTrue();
        assertThat(Files.readString(marker)).isEqualTo(original);
        legacy.guard().verify(legacy.binding(resumed));
        Files.writeString(marker, "{}");
        assertThatThrownBy(() -> legacy.guard().verify(legacy.binding(resumed))).isInstanceOf(RuntimeBrokerException.class);
    }
}
