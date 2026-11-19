package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import javax.sql.DataSource;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ResidentWorkspaceReuseConcurrencyTest {
    protected DataSource dataSource() {
        return new DriverManagerDataSource("jdbc:h2:mem:resident-reuse-race-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    @Test
    @Timeout(25)
    void retainedTenantRefusesAnAliasRegisteredBeforeTheFirstReservation() {
        var fixture = new ResidentRetirementFixture(dataSource());
        var original = fixture.mapping.registration();
        var foreign = new WorkspaceCsiRegistration("foreign", "foreign-storage", original.clusterDomain(), original.namespace(),
                original.pvcName(), original.pvcUid(), original.pvName(), original.pvUid(), original.driver(), original.volumeHandle(),
                original.backendDomain(), original.diskSerial(), original.mountRoot(), original.revision());
        fixture.storage.register(foreign);
        assertThat(fixture.storage.inspect(foreign).revision()).isZero();
        var mapping = new ResidentWorkspace("foreign-workspace", 1, foreign, fixture.mapping.protection(),
                fixture.mapping.image(), fixture.mapping.command(), fixture.mapping.artifacts());
        new ResidentWorkspaces(List.of(mapping));
        fixture.jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name,"
                + " config_ref, policy_ref, state) VALUES ('foreign', 'foreign-workspace', 1, 'foreign-storage', 'resident', ?, ?, 'ACTIVE')",
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        var request = new RuntimeProvisionRequest(ResidentWorkspaces.scope(mapping), null,
                WorkspaceCsiReservationStore.PROVISIONER_KIND, foreign.storageId());
        var created = fixture.bindings.findOrCreate(request);
        var foreignBinding = fixture.bindings.claimOperation(created.getBindingId(), "foreign-owner", Duration.ofMinutes(5));
        assertThat(foreignBinding).isNotNull();
        String reservationId = UUID.randomUUID().toString();
        fixture.ready();
        assertThatThrownBy(() -> fixture.storage.inspect(foreign)).isInstanceOf(RuntimeBrokerException.class);
        assertThatThrownBy(() -> fixture.storage.reserve(foreign, fixture.bindings, foreignBinding, reservationId))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, failure -> assertThat(failure.getCode()).isEqualTo("workspace_csi_busy"));
        fixture.preparePlatform();
        fixture.store().begin(fixture.request);
        var api = fixture.api();
        new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).prepareReclamation(fixture.request, "10", api);
        new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "11", api);
        fixture.completePlatform();
        assertThat(new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, api).state()).isEqualTo("RELEASED");
        var released = fixture.storage.inspect(original);
        assertThat(released.revision()).isEqualTo(2);
        assertThatThrownBy(() -> fixture.storage.inspect(foreign)).isInstanceOf(RuntimeBrokerException.class);
        assertThatThrownBy(() -> fixture.storage.register(foreign)).isInstanceOf(RuntimeBrokerException.class);
        assertThatThrownBy(() -> fixture.storage.reserve(foreign, fixture.bindings, foreignBinding, reservationId))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, failure -> assertThat(failure.getCode()).isEqualTo("workspace_csi_unavailable"));
        assertThat(fixture.storage.inspect(original)).isEqualTo(released);
        assertThat(fixture.jdbc.queryForObject("SELECT tenant_id FROM ma_storage_owner", String.class)).isEqualTo("tenant");
    }

    @Test
    @Timeout(25)
    void sameTenantAliasesCompeteAtRevisionThreeAfterOriginalRetirement() throws Exception {
        var fixture = new ResidentRetirementFixture(dataSource());
        fixture.ready();
        assertThat(fixture.storage.inspect(fixture.mapping.registration()).revision()).isEqualTo(1);
        fixture.preparePlatform();
        fixture.store().begin(fixture.request);
        var api = fixture.api();
        new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).prepareReclamation(fixture.request, "10", api);
        new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "11", api);
        fixture.completePlatform();
        var terminal = new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, api);
        assertThat(terminal.state()).isEqualTo("RELEASED");
        assertThat(terminal.completion().releasedRevision()).isEqualTo(2);
        assertThat(fixture.storage.inspect(fixture.mapping.registration()).phase()).isEqualTo("RELEASED");
        assertThat(fixture.storage.inspect(fixture.mapping.registration()).revision()).isEqualTo(2);
        assertThat(fixture.jdbc.queryForObject("SELECT tenant_id FROM ma_storage_owner", String.class)).isEqualTo("tenant");

        var first = contender(fixture, "reuse-a", "alias-a");
        var second = contender(fixture, "reuse-b", "alias-b");
        assertThat(first.registration().aliasKey()).isNotEqualTo(second.registration().aliasKey());
        assertThat(first.registration().physicalKey()).isEqualTo(second.registration().physicalKey());
        var barrier = new CyclicBarrier(2);
        boolean firstWon;
        boolean secondWon;
        try (var executor = Executors.newFixedThreadPool(2)) {
            var one = executor.submit(() -> contend(fixture, first, barrier));
            var two = executor.submit(() -> contend(fixture, second, barrier));
            firstWon = one.get(10, TimeUnit.SECONDS);
            secondWon = two.get(10, TimeUnit.SECONDS);
        }
        assertThat(firstWon ^ secondWon).isTrue();
        var winner = firstWon ? first : second;
        var loser = firstWon ? second : first;
        var held = fixture.storage.inspect(winner.registration());
        assertThat(held.phase()).isEqualTo("RESERVED");
        assertThat(held.revision()).isEqualTo(3);
        assertThat(held.reservationId()).isEqualTo(winner.reservationId());
        assertThat(held.registrationKey()).isEqualTo(winner.registration().aliasKey());
        assertThat(held.bindingId()).isEqualTo(winner.binding().getBindingId());
        assertThat(held.runtimeGeneration()).isEqualTo(winner.binding().getGeneration());
        assertThat(held.provisionRequestId()).isEqualTo(winner.binding().getProvisionSeed().getProvisionRequestId());
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Long.class)).isEqualTo(1);
        assertThat(fixture.jdbc.queryForObject("SELECT tenant_id FROM ma_storage_owner", String.class)).isEqualTo("tenant");

        assertThatThrownBy(() -> fixture.storage.reserve(loser.registration(), fixture.bindings,
                loser.binding(), loser.reservationId())).isInstanceOfSatisfying(RuntimeBrokerException.class,
                        failure -> assertThat(failure.getCode()).isEqualTo("workspace_csi_busy"));
        assertThat(fixture.storage.inspect(winner.registration())).isEqualTo(held);
        assertThat(fixture.storage.reserve(winner.registration(), fixture.bindings,
                winner.binding(), winner.reservationId())).isEqualTo(held);
        assertThat(new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, api)).isEqualTo(terminal);
        assertThat(fixture.store().begin(fixture.request)).isEqualTo(terminal);
        assertThatThrownBy(() -> fixture.bindings.findOrCreate(fixture.runtimeRequest)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(fixture.storage.inspect(winner.registration())).isEqualTo(held);
        assertThat(fixture.jdbc.queryForObject("SELECT tenant_id FROM ma_storage_owner", String.class)).isEqualTo("tenant");
        assertThat(fixture.jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot WHERE request_key = ?",
                String.class, fixture.runtimeRequest.requestKey())).isNull();
        assertThat(fixture.jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot WHERE request_key = ?",
                String.class, winner.binding().getRequest().requestKey())).isEqualTo(winner.binding().getBindingId());
    }

    private static Contender contender(ResidentRetirementFixture fixture, String workspace, String storage) {
        var original = fixture.mapping.registration();
        var registration = new WorkspaceCsiRegistration(original.tenantId(), storage, original.clusterDomain(), original.namespace(),
                original.pvcName(), original.pvcUid(), original.pvName(), original.pvUid(), original.driver(), original.volumeHandle(),
                original.backendDomain(), original.diskSerial(), original.mountRoot(), original.revision());
        fixture.storage.register(registration);
        var mapping = new ResidentWorkspace(workspace, 1, registration, fixture.mapping.protection(),
                fixture.mapping.image(), fixture.mapping.command(), fixture.mapping.artifacts());
        var selected = new ResidentWorkspaces(List.of(mapping)).require(ResidentWorkspaces.scope(mapping));
        ResidentWorkspaces.requireRegistration(fixture.jdbc, selected);
        fixture.jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name,"
                + " config_ref, policy_ref, state) VALUES ('tenant', ?, 1, ?, 'resident', ?, ?, 'ACTIVE')", workspace, storage,
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        var request = new RuntimeProvisionRequest(ResidentWorkspaces.scope(selected), null,
                WorkspaceCsiReservationStore.PROVISIONER_KIND, storage);
        var created = fixture.bindings.findOrCreate(request);
        var claimed = fixture.bindings.claimOperation(created.getBindingId(), "reuse-" + workspace, Duration.ofMinutes(5));
        assertThat(claimed).isNotNull();
        return new Contender(registration, claimed, UUID.randomUUID().toString());
    }

    private static boolean contend(ResidentRetirementFixture fixture, Contender contender, CyclicBarrier barrier) throws Exception {
        var store = new WorkspaceCsiReservationStore(new ManagedSchemaJdbcTemplate(fixture.source),
                new DataSourceTransactionManager(fixture.source), new ObjectMapper());
        barrier.await(5, TimeUnit.SECONDS);
        try {
            store.reserve(contender.registration(), fixture.bindings, contender.binding(), contender.reservationId());
            return true;
        } catch (RuntimeBrokerException failure) {
            assertThat(failure.getCode()).isEqualTo("workspace_csi_busy");
            return false;
        }
    }

    private record Contender(WorkspaceCsiRegistration registration, RuntimeBindingRecord binding, String reservationId) { }
}
