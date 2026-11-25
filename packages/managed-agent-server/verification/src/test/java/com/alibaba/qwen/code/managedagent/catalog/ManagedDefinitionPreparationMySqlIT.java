package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionPreparation;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionPreparation.Command;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Exact;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.SourceRef;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.ToolPolicy;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.managedagent.persistence.JdbcDefinitionPreparationStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.repository.ManagedDefinitionPreparationStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedDefinitionPreparationMySqlIT {
    @ParameterizedTest
    @NullSource
    @ValueSource(strings = "default")
    void concurrentPreparationConvergesOnOneNativeDefinition(String approvalMode) throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new ManagedSchemaJdbcTemplate(database.source());
            var json = new ObjectMapper();
            var digests = new RequestDigests();
            var definitions = transactionalDefinitions(database.source(), jdbc, digests, json);
            var reference = new SourceRef("catalog", "agent-1", "release-1", "a".repeat(64), "workspace");
            var input = new ManagedAgentDefinitionSource.Definition(reference, "qwen-test", "Review.",
                    new ToolPolicy("hosted-workspace-files/1", approvalMode), List.of(), List.of(), List.of());
            ManagedAgentDefinitionSource source = new ManagedAgentDefinitionSource() {
                @Override
                public String id() {
                    return "catalog";
                }

                @Override
                public Definition resolve(Context context, Selection selection) {
                    return input;
                }
            };
            var workspaces = mock(ManagedWorkspaceRegistry.class);
            when(workspaces.accessOf("tenant", "actor", "workspace")).thenReturn(WorkspaceAccess.OPERATOR);
            var providers = new ManagedDefinitionInputProviders("SPI", provider(source), provider(), workspaces);
            var store = new JdbcDefinitionPreparationStore(jdbc, json);
            var racing = new RacingStore(store);
            var bootstraps = mock(com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedAgentBootstrapPreparation.class);
            when(bootstraps.prepare(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any())).thenReturn(List.of());
            var service = new ManagedDefinitionPreparationService(definitions, racing, providers, digests, json, bootstraps);
            var command = new Command("tenant", "actor", "workspace", "workspace", "prepare-1",
                    new Exact(reference), Instant.now().plusSeconds(30));
            try (var executor = Executors.newFixedThreadPool(2)) {
                var first = executor.submit(() -> service.prepare(command));
                var second = executor.submit(() -> service.prepare(command));

                assertThat(first.get(30, TimeUnit.SECONDS).definition())
                        .isEqualTo(second.get(30, TimeUnit.SECONDS).definition());
                assertThat(serviceReplay(definitions, store, providers, digests, json, command).definition())
                        .isEqualTo(first.get().definition());
            } finally {
                assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
            }

            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_agent_definition", Integer.class)).isOne();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt"
                    + " WHERE namespace = 'SOURCE_DEFINITION_PREPARATION'", Integer.class)).isOne();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt"
                    + " WHERE namespace = 'AGENT_DEFINITION'", Integer.class)).isOne();
            var saved = json.readTree(jdbc.queryForObject("SELECT result_json FROM ma_request_receipt"
                    + " WHERE namespace = 'SOURCE_DEFINITION_PREPARATION'", String.class));
            assertThat(saved.at("/input/toolPolicy/approvalMode").textValue()).isEqualTo(approvalMode);
            var definition = json.readTree(jdbc.queryForObject("SELECT definition_json FROM ma_agent_definition", String.class));
            assertThat(definition.at("/permission_policy/approval_mode").textValue()).isEqualTo(approvalMode);
        }
    }

    @Test
    void concurrentCurrentPreparationConvergesOnTheFirstSavedProjection() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new ManagedSchemaJdbcTemplate(database.source());
            var json = new ObjectMapper();
            var digests = new RequestDigests();
            var definitions = transactionalDefinitions(database.source(), jdbc, digests, json);
            var firstRef = new SourceRef("catalog", "agent-1", "release-1", "a".repeat(64), "workspace");
            var laterRef = new SourceRef("catalog", "agent-1", "release-2", "c".repeat(64), "workspace");
            var firstInput = definition(firstRef);
            var laterInput = definition(laterRef);
            var resolutions = new AtomicInteger();
            var firstEntered = new CountDownLatch(1);
            var releaseFirst = new CountDownLatch(1);
            var source = mock(ManagedAgentDefinitionSource.class);
            when(source.id()).thenReturn("catalog");
            org.mockito.Mockito.doAnswer(invocation -> {
                if (resolutions.incrementAndGet() == 1) {
                    firstEntered.countDown();
                    assertThat(releaseFirst.await(10, TimeUnit.SECONDS)).isTrue();
                    return firstInput;
                }
                return laterInput;
            }).when(source).resolve(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.eq(new ManagedAgentDefinitionSource.Current("agent-1")));
            var workspaces = mock(ManagedWorkspaceRegistry.class);
            when(workspaces.accessOf("tenant", "actor", "workspace")).thenReturn(WorkspaceAccess.OPERATOR);
            var providers = new ManagedDefinitionInputProviders("SPI", provider(source), provider(), workspaces);
            var store = new RacingStore(new JdbcDefinitionPreparationStore(jdbc, json), releaseFirst::countDown);
            var service = new ManagedDefinitionPreparationService(definitions, store, providers, digests, json,
                    (context, bundles) -> List.of());
            var command = new Command("tenant", "actor", "workspace", "workspace", "prepare-1",
                    new ManagedAgentDefinitionSource.Current("agent-1"), Instant.now().plusSeconds(30));
            try (var executor = Executors.newFixedThreadPool(2)) {
                var losing = executor.submit(() -> service.prepare(command));
                assertThat(firstEntered.await(10, TimeUnit.SECONDS)).isTrue();
                var winner = executor.submit(() -> service.prepare(command));

                assertThat(losing.get(30, TimeUnit.SECONDS).definition())
                        .isEqualTo(winner.get(30, TimeUnit.SECONDS).definition());
            } finally {
                releaseFirst.countDown();
                assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
            }

            assertThat(resolutions).hasValue(2);
            assertThat(json.readTree(jdbc.queryForObject("SELECT result_json FROM ma_request_receipt"
                    + " WHERE namespace = 'SOURCE_DEFINITION_PREPARATION'", String.class))
                    .at("/input/ref/sourceRevision").asText()).isEqualTo("release-2");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_agent_definition", Integer.class)).isOne();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt"
                    + " WHERE namespace = 'SOURCE_DEFINITION_PREPARATION'", Integer.class)).isOne();
        }
    }

    private static ManagedAgentDefinitionService transactionalDefinitions(javax.sql.DataSource dataSource,
            ManagedSchemaJdbcTemplate jdbc, RequestDigests digests, ObjectMapper json) {
        var definitionStore = new JdbcManagedAgentDefinitionStore(jdbc, digests);
        var proxy = new org.springframework.transaction.interceptor.TransactionProxyFactoryBean();
        proxy.setTarget(definitionStore);
        proxy.setProxyTargetClass(true);
        proxy.setTransactionAttributeSource(new org.springframework.transaction.annotation.AnnotationTransactionAttributeSource());
        proxy.setTransactionManager(new org.springframework.jdbc.datasource.DataSourceTransactionManager(dataSource));
        proxy.afterPropertiesSet();
        return new ManagedAgentDefinitionService((JdbcManagedAgentDefinitionStore) proxy.getObject(), digests, json);
    }

    private static ManagedAgentDefinitionSource.Definition definition(SourceRef reference) {
        return new ManagedAgentDefinitionSource.Definition(reference, "qwen-test", "Review.",
                new ToolPolicy("hosted-workspace-files/1", "default"), List.of(), List.of(), List.of());
    }

    private static ManagedAgentDefinitionPreparation.PrepareReceipt serviceReplay(
            ManagedAgentDefinitionService definitions, ManagedDefinitionPreparationStore store,
            ManagedDefinitionInputProviders providers, RequestDigests digests,
            ObjectMapper json, Command command) {
        return new ManagedDefinitionPreparationService(definitions, store, providers, digests, json,
                (context, bundles) -> List.of()).prepare(command);
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(T... values) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.orderedStream()).thenReturn(java.util.Arrays.stream(values));
        return provider;
    }

    private static final class RacingStore implements ManagedDefinitionPreparationStore {
        private final ManagedDefinitionPreparationStore delegate;
        private final CyclicBarrier admitted;
        private final Runnable afterResolve;

        private RacingStore(ManagedDefinitionPreparationStore delegate) {
            this(delegate, null);
        }

        private RacingStore(ManagedDefinitionPreparationStore delegate, Runnable afterResolve) {
            this.delegate = delegate;
            this.admitted = afterResolve == null ? new CyclicBarrier(2) : null;
            this.afterResolve = afterResolve;
        }

        @Override
        public Preparation begin(String tenantId, String scopeId, String operationKey,
                String requestDigest, byte[] actorKey, long now) {
            var result = delegate.begin(tenantId, scopeId, operationKey, requestDigest, actorKey, now);
            if (admitted != null) {
                try {
                    admitted.await(10, TimeUnit.SECONDS);
                } catch (Exception error) {
                    throw new IllegalStateException(error);
                }
            }
            return result;
        }

        @Override
        public void resolve(String tenantId, String scopeId, String operationKey,
                ManagedAgentDefinitionSource.Definition input, String resultJson, long now) {
            delegate.resolve(tenantId, scopeId, operationKey, input, resultJson, now);
            if (afterResolve != null) {
                afterResolve.run();
            }
        }

        @Override
        public void complete(String tenantId, String scopeId, String operationKey,
                com.alibaba.qwen.code.managedagent.model.ApiModels.AgentDefinition definition,
                java.util.List<com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedAgentBootstrapPreparation.PreparedBundle> bundles,
                String resultJson, long now) {
            delegate.complete(tenantId, scopeId, operationKey, definition, bundles, resultJson, now);
        }

        @Override
        public Optional<Preparation> find(String tenantId, String scopeId, String operationKey,
                String requestDigest) {
            return delegate.find(tenantId, scopeId, operationKey, requestDigest);
        }
    }
}
