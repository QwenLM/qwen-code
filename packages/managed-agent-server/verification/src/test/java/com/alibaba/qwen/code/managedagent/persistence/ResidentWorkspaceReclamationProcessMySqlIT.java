package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.provisioning.KubernetesHttpRuntimeClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.DefaultTransactionStatus;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ResidentWorkspaceReclamationProcessMySqlIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    @TempDir
    private Path directory;

    @ParameterizedTest
    @ValueSource(strings = {"before-receipt", "after-receipt", "before", "after"})
    @Timeout(45)
    void killedReleaseProcessReadsEitherWholeHeldStateOrWholeReleasedState(String cut) throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var fixture = new ResidentRetirementFixture(database.source());
            fixture.ready();
            fixture.preparePlatform();
            fixture.store().begin(fixture.request);
            var api = fixture.api();
            new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).prepareReclamation(fixture.request, "10", api);
            new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "11", api);
            fixture.completePlatform();
            doReturn(CompletableFuture.completedFuture(new KubernetesHttpRuntimeClient.DeleteResponse(503, new byte[0], true)))
                    .when(api).patchPodFinalizers(anyString(), anyString(), any(byte[].class));
            if (!cut.endsWith("receipt")) {
                assertThat(new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, api).state()).isEqualTo("PLATFORM_CLEANED");
            }
            Path input = directory.resolve("request.json");
            JSON.writeValue(input.toFile(), Map.of("mapping", fixture.mapping, "request", fixture.request, "cut", cut,
                    "objects", fixture.objects));
            Path log = directory.resolve("child.log");
            var command = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-cp",
                    System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                    ResidentWorkspaceReclamationProcessMySqlIT.class.getName(), input.toString());
            command.environment().put("RECLAMATION_MYSQL_URL", database.url());
            command.environment().put("RECLAMATION_MYSQL_USER", System.getProperty("mysql.user"));
            command.environment().put("RECLAMATION_MYSQL_PASSWORD", System.getProperty("mysql.password", ""));
            var child = command.redirectErrorStream(true).redirectOutput(log.toFile()).start();
            try {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
                while (!Files.exists(directory.resolve("cut")) && child.isAlive() && System.nanoTime() < deadline) {
                    Thread.sleep(25);
                }
                assertThat(Files.exists(directory.resolve("cut"))).withFailMessage("Child did not reach commit cut: %s", Files.readString(log)).isTrue();
                child.destroyForcibly();
                assertThat(child.waitFor(5, TimeUnit.SECONDS)).isTrue();
                var state = fixture.store().inspect(fixture.request);
                assertThat(state.state()).isEqualTo(cut.equals("before-receipt") ? "DRAINING"
                        : cut.equals("after") ? "RELEASED" : "PLATFORM_CLEANED");
                assertThat(fixture.storage.inspect(fixture.mapping.registration()).phase())
                        .isEqualTo(cut.equals("after") ? "RELEASED" : "RESERVED");
                assertThat(fixture.bindings.findById(fixture.original.getBindingId()).getState())
                        .isEqualTo(cut.equals("after") ? RuntimeBindingRecord.State.RELEASED : RuntimeBindingRecord.State.DRAINING);
                if (!cut.equals("after")) {
                    assertThat(new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, fixture.api()).state()).isEqualTo("RELEASED");
                }
                assertThat(fixture.jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot", String.class)).isNull();
                assertThat(fixture.storage.inspect(fixture.mapping.registration()).revision()).isEqualTo(2);
                var unused = ResidentRetirementFixture.maintenanceMethods(mock(KubernetesHttpRuntimeClient.class));
                assertThat(new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, unused).state()).isEqualTo("RELEASED");
                verifyNoInteractions(unused);
            } finally {
                if (child.isAlive()) {
                    child.destroyForcibly().waitFor(5, TimeUnit.SECONDS);
                }
            }
        }
    }

    public static void main(String[] args) throws Exception {
        Path input = Path.of(args[0]);
        var document = JSON.readTree(input.toFile());
        var selected = JSON.treeToValue(document.get("mapping"), ResidentWorkspace.class);
        var request = JSON.treeToValue(document.get("request"), ResidentWorkspaceRetirementStore.Request.class);
        String cut = document.get("cut").textValue();
        var source = new DriverManagerDataSource(System.getenv("RECLAMATION_MYSQL_URL"),
                System.getenv("RECLAMATION_MYSQL_USER"), System.getenv("RECLAMATION_MYSQL_PASSWORD"));
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source) {
            @Override
            protected void doCommit(DefaultTransactionStatus status) {
                String state = jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'WORKSPACE_RETIREMENT'", String.class);
                boolean releasing = state.equals("RELEASED");
                boolean recording = state.equals("PLATFORM_CLEANED");
                if (releasing && cut.equals("before") || recording && cut.equals("before-receipt")) {
                    awaitKill(input);
                }
                super.doCommit(status);
                if (releasing && cut.equals("after") || recording && cut.equals("after-receipt")) {
                    awaitKill(input);
                }
            }
        };
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        var api = ResidentRetirementFixture.maintenanceMethods(mock(KubernetesHttpRuntimeClient.class));
        var objects = JSON.convertValue(document.get("objects"),
                new com.fasterxml.jackson.core.type.TypeReference<Map<String, Map<String, Object>>>() { });
        when(api.get(anyString(), anyString(), anyString())).thenAnswer(call -> CompletableFuture.completedFuture(
                cut.endsWith("receipt") ? objects.get(call.<String>getArgument(0)) : null));
        when(api.getCluster(anyString(), anyString())).thenAnswer(call -> CompletableFuture.completedFuture(objects.get(call.<String>getArgument(0))));
        when(api.getNodeLease(anyString())).thenReturn(CompletableFuture.completedFuture(objects.get("leases")));
        when(api.listPersistentVolumes()).thenReturn(CompletableFuture.completedFuture(List.of(objects.get("persistentvolumes"))));
        when(api.listPods(anyString())).thenReturn(CompletableFuture.completedFuture(List.of(objects.get("pods"))));
        when(api.listVolumeAttachments()).thenReturn(CompletableFuture.completedFuture(List.of()));
        new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(new ResidentWorkspaceRetirementStore(jdbc, manager, bindings, List.of(selected), JSON)).reclaim(request, api);
    }

    private static void awaitKill(Path input) {
        try {
            Files.writeString(input.resolveSibling("cut"), "ready");
            Thread.sleep(30_000);
            throw new IllegalStateException("Parent did not kill maintenance process");
        } catch (java.io.IOException failure) {
            throw new java.io.UncheckedIOException(failure);
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(failure);
        }
    }
}
