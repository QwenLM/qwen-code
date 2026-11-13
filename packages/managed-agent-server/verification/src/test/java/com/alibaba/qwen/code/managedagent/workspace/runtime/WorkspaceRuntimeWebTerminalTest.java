package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The web-terminal opt-in selects the terminal-capable measured digest for
 * newly resolved ordinary local Workspace bindings, and refuses startup
 * without tool measurements.
 */
class WorkspaceRuntimeWebTerminalTest {
    private static final String TENANT = "terminal-tenant";
    private static final String ACTOR = "actor-a";
    private static final String WS = "ws-a";
    private static final String STORAGE = "storage-a";

    @TempDir
    private Path temporary;

    private record Fixture(ManagedAgentProperties properties,
            WorkspaceRuntimeResolver resolver, String sessionId,
            ManagedAgentStore store) {
    }

    private Fixture fixture(boolean toolMeasurements, boolean webTerminal)
            throws Exception {
        Path root = Files.createDirectory(temporary.resolve(
                "mount-" + UUID.randomUUID())).toRealPath();
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:terminal-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(dataSource);
        JdbcTemplate jdbc = new ManagedSchemaJdbcTemplate(dataSource);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getRuntimeBroker().setProvisioner("local-process");
        properties.getRuntimeBroker().setIsolationClass("session");
        properties.getRuntimeBroker().setToolMeasurements(toolMeasurements);
        properties.getRuntimeBroker().setWebTerminal(webTerminal);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                        TENANT, STORAGE, root.toString())));
        ManagedAgentStore store =
                com.alibaba.qwen.code.managedagent.VerificationFixtures
                        .managedAgentStore(jdbc, new ObjectMapper(),
                                Clock.systemUTC(), ignored -> {},
                                new JdbcManagedWorkspaceRegistry(jdbc),
                                properties,
                                new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        WorkspaceRuntimeResolver resolver = new WorkspaceRuntimeResolver(
                store,
                com.alibaba.qwen.code.managedagent.VerificationFixtures
                        .configure(new JdbcWorkspaceExecutionStore(jdbc,
                                new DataSourceTransactionManager(dataSource))),
                properties);
        String sessionId = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource))
                .execute(status -> {
                    jdbc.update("INSERT INTO ma_workspace"
                            + " (tenant_id, workspace_id,"
                            + " workspace_generation, storage_id,"
                            + " display_name, config_ref, policy_ref,"
                            + " state) VALUES (?, ?, 1, ?, ?, ?, ?,"
                            + " 'ACTIVE')", TENANT, WS, STORAGE, WS,
                            WorkspaceExecutionProfile.CONFIG_REF,
                            WorkspaceExecutionProfile.POLICY_REF);
                    jdbc.update("INSERT INTO ma_workspace_access"
                            + " (tenant_id, workspace_id, actor_id, role)"
                            + " VALUES (?, ?, ?, 'OPERATOR')", TENANT, WS,
                            ACTOR.getBytes(java.nio.charset
                                    .StandardCharsets.UTF_8));
                    return store.insertWorkspaceSessionCommand(
                            SessionCreationCommand.builder()
                                    .tenantId(TENANT)
                                    .actorId(ACTOR)
                                    .idempotencyKey("create")
                                    .requestDigest("digest")
                                    .agentId("qwen-code")
                                    .selection(new WorkspaceSelection(WS, "."))
                                    .build())
                            .sessionId();
                });
        return new Fixture(properties, resolver, sessionId, store);
    }

    @Test
    void optInSelectsTheTerminalDigest() throws Exception {
        Fixture fixture = fixture(true, true);
        assertThat(fixture.resolver().resolve(fixture.sessionId()).scope()
                .getCapabilityDigest())
                .isEqualTo(WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST);
    }

    @Test
    void withoutOptInMeasuredResolutionKeepsItsDigest() throws Exception {
        Fixture measured = fixture(true, false);
        assertThat(measured.resolver().resolve(measured.sessionId()).scope()
                .getCapabilityDigest())
                .isEqualTo(WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST);
        Fixture ordinary = fixture(false, false);
        assertThat(ordinary.resolver().resolve(ordinary.sessionId()).scope()
                .getCapabilityDigest())
                .isEqualTo(WorkspaceExecutionProfile.CAPABILITY_DIGEST);
    }

    @Test
    void optInWithoutMeasurementsRefusesStartup() throws Exception {
        assertThatThrownBy(() -> fixture(false, true))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("tool measurements");
    }

    @Test
    void capabilityHintRequiresTheRecordedTerminalDigest() throws Exception {
        Fixture fixture = fixture(true, true);
        var session = fixture.store().requireSession(TENANT, fixture.sessionId());
        // Without a wired repository the placement check stands.
        assertThat(fixture.resolver().terminalCapable(session)).isTrue();
        // A binding recorded at the measured digest is refused by the relay's
        // admission, so the hint must not advertise a terminal for it.
        var repository = org.mockito.Mockito.mock(
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository.class);
        var binding = org.mockito.Mockito.mock(
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.class);
        var request = org.mockito.Mockito.mock(
                com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest.class);
        org.mockito.Mockito.when(binding.getState())
                .thenReturn(com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.READY);
        org.mockito.Mockito.when(binding.getRequest()).thenReturn(request);
        org.mockito.Mockito.when(request.getScope()).thenReturn(
                new com.alibaba.qwen.code.runtimebroker.RuntimeScope(
                        TENANT, WS, "1", "/workspace",
                        WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST, "session"));
        org.mockito.Mockito.when(repository.findByHarnessSession(
                org.mockito.ArgumentMatchers.eq(TENANT),
                org.mockito.ArgumentMatchers.eq(fixture.sessionId()),
                org.mockito.ArgumentMatchers.isNull(),
                org.mockito.ArgumentMatchers.anyInt()))
                .thenReturn(List.of(binding));
        fixture.resolver().setBindingRepository(repository);
        assertThat(fixture.resolver().terminalCapable(session)).isFalse();
    }

    private static com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord binding(
            String id,
            com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State state,
            String digest, boolean drainRequested) {
        var record = org.mockito.Mockito.mock(
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.class);
        var request = org.mockito.Mockito.mock(
                com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest.class);
        org.mockito.Mockito.when(record.getBindingId()).thenReturn(id);
        org.mockito.Mockito.when(record.getState()).thenReturn(state);
        org.mockito.Mockito.when(record.isDrainRequested()).thenReturn(drainRequested);
        org.mockito.Mockito.when(record.getRequest()).thenReturn(request);
        org.mockito.Mockito.when(request.getScope()).thenReturn(
                new com.alibaba.qwen.code.runtimebroker.RuntimeScope(
                        TENANT, WS, "1", "/workspace", digest, "session"));
        return record;
    }

    @Test
    void capabilityHintAcceptsARecordedTerminalDigestBinding() throws Exception {
        Fixture fixture = fixture(true, true);
        var session = fixture.store().requireSession(TENANT, fixture.sessionId());
        var repository = org.mockito.Mockito.mock(
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository.class);
        var terminalBinding = binding("b-1",
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.READY,
                WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST, false);
        org.mockito.Mockito.when(repository.findByHarnessSession(
                org.mockito.ArgumentMatchers.eq(TENANT),
                org.mockito.ArgumentMatchers.eq(fixture.sessionId()),
                org.mockito.ArgumentMatchers.isNull(),
                org.mockito.ArgumentMatchers.anyInt()))
                .thenReturn(List.of(terminalBinding));
        fixture.resolver().setBindingRepository(repository);
        assertThat(fixture.resolver().terminalCapable(session)).isTrue();
    }

    @Test
    void capabilityHintReadsTheLastReadyRowNotAnyReadyRow() throws Exception {
        Fixture fixture = fixture(true, true);
        var session = fixture.store().requireSession(TENANT, fixture.sessionId());
        var repository = org.mockito.Mockito.mock(
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository.class);
        fixture.resolver().setBindingRepository(repository);
        var ready = com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.READY;
        var measured = binding("b-1", ready,
                WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST, false);
        var terminal = binding("b-2", ready,
                WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST, false);
        // Ascending binding ids: the newer terminal row wins over the older
        // measured row, so the hint is true.
        org.mockito.Mockito.when(repository.findByHarnessSession(
                org.mockito.ArgumentMatchers.eq(TENANT),
                org.mockito.ArgumentMatchers.eq(fixture.sessionId()),
                org.mockito.ArgumentMatchers.isNull(),
                org.mockito.ArgumentMatchers.anyInt()))
                .thenReturn(List.of(measured, terminal));
        assertThat(fixture.resolver().terminalCapable(session)).isTrue();
        // Reversed ids: the newest READY row is measured, so the hint is false
        // even though an older terminal row exists.
        var olderTerminal = binding("b-1", ready,
                WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST, false);
        var newerMeasured = binding("b-2", ready,
                WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST, false);
        org.mockito.Mockito.when(repository.findByHarnessSession(
                org.mockito.ArgumentMatchers.eq(TENANT),
                org.mockito.ArgumentMatchers.eq(fixture.sessionId()),
                org.mockito.ArgumentMatchers.isNull(),
                org.mockito.ArgumentMatchers.anyInt()))
                .thenReturn(List.of(olderTerminal, newerMeasured));
        assertThat(fixture.resolver().terminalCapable(session)).isFalse();
    }

    @Test
    void capabilityHintPagesPastTheFirstHundredRows() throws Exception {
        Fixture fixture = fixture(true, true);
        var session = fixture.store().requireSession(TENANT, fixture.sessionId());
        var repository = org.mockito.Mockito.mock(
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository.class);
        var ready = com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.READY;
        // A full first page of measured rows, then a second page whose newest
        // READY row carries the terminal digest. A single-page read would stop
        // at the measured rows and answer false while admission succeeds.
        var firstPage = new java.util.ArrayList<
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord>();
        for (int i = 0; i < 100; i++) {
            firstPage.add(binding(String.format("b-%03d", i), ready,
                    WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST, false));
        }
        var terminalBinding = binding("b-100", ready,
                WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST, false);
        org.mockito.Mockito.when(repository.findByHarnessSession(
                org.mockito.ArgumentMatchers.eq(TENANT),
                org.mockito.ArgumentMatchers.eq(fixture.sessionId()),
                org.mockito.ArgumentMatchers.isNull(),
                org.mockito.ArgumentMatchers.anyInt()))
                .thenReturn(firstPage);
        org.mockito.Mockito.when(repository.findByHarnessSession(
                org.mockito.ArgumentMatchers.eq(TENANT),
                org.mockito.ArgumentMatchers.eq(fixture.sessionId()),
                org.mockito.ArgumentMatchers.eq("b-099"),
                org.mockito.ArgumentMatchers.anyInt()))
                .thenReturn(List.of(terminalBinding));
        fixture.resolver().setBindingRepository(repository);
        assertThat(fixture.resolver().terminalCapable(session)).isTrue();
    }

    @Test
    void capabilityHintRefusesADrainingTerminalBinding() throws Exception {
        Fixture fixture = fixture(true, true);
        var session = fixture.store().requireSession(TENANT, fixture.sessionId());
        var repository = org.mockito.Mockito.mock(
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository.class);
        // A READY terminal-digest row that is draining must not advertise a
        // terminal: the relay would attach to a runtime on its way out.
        var draining = binding("b-1",
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.READY,
                WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST, true);
        org.mockito.Mockito.when(repository.findByHarnessSession(
                org.mockito.ArgumentMatchers.eq(TENANT),
                org.mockito.ArgumentMatchers.eq(fixture.sessionId()),
                org.mockito.ArgumentMatchers.isNull(),
                org.mockito.ArgumentMatchers.anyInt()))
                .thenReturn(List.of(draining));
        fixture.resolver().setBindingRepository(repository);
        assertThat(fixture.resolver().terminalCapable(session)).isFalse();
    }

    @Test
    void capabilityHintPagesWithTheRepositoryBoundLimit() throws Exception {
        Fixture fixture = fixture(true, true);
        var session = fixture.store().requireSession(TENANT, fixture.sessionId());
        var repository = org.mockito.Mockito.mock(
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository.class);
        var terminalBinding = binding("b-1",
                com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.READY,
                WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST, false);
        // Pin the page size to the repository's 1-100 bound: a limit outside it
        // would be rejected by the real repository, so anyInt() alone hides a
        // production page size that drifts past the bound.
        org.mockito.Mockito.when(repository.findByHarnessSession(
                org.mockito.ArgumentMatchers.eq(TENANT),
                org.mockito.ArgumentMatchers.eq(fixture.sessionId()),
                org.mockito.ArgumentMatchers.isNull(),
                org.mockito.ArgumentMatchers.eq(100)))
                .thenReturn(List.of(terminalBinding));
        fixture.resolver().setBindingRepository(repository);
        assertThat(fixture.resolver().terminalCapable(session)).isTrue();
        org.mockito.Mockito.verify(repository).findByHarnessSession(
                org.mockito.ArgumentMatchers.eq(TENANT),
                org.mockito.ArgumentMatchers.eq(fixture.sessionId()),
                org.mockito.ArgumentMatchers.isNull(),
                org.mockito.ArgumentMatchers.eq(100));
    }
}
