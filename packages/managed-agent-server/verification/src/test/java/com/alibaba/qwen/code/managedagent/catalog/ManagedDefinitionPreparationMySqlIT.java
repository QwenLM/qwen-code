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
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedDefinitionPreparationMySqlIT {
    @Test
    void concurrentPreparationConvergesOnOneNativeDefinition() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new ManagedSchemaJdbcTemplate(database.source());
            var json = new ObjectMapper();
            var digests = new RequestDigests();
            var definitionStore = new JdbcManagedAgentDefinitionStore(jdbc, digests);
            var proxy = new org.springframework.transaction.interceptor.TransactionProxyFactoryBean();
            proxy.setTarget(definitionStore);
            proxy.setProxyTargetClass(true);
            proxy.setTransactionAttributeSource(new org.springframework.transaction.annotation.AnnotationTransactionAttributeSource());
            proxy.setTransactionManager(new org.springframework.jdbc.datasource.DataSourceTransactionManager(database.source()));
            proxy.afterPropertiesSet();
            var definitions = new ManagedAgentDefinitionService(
                    (JdbcManagedAgentDefinitionStore) proxy.getObject(),
                    digests, json);
            var reference = new SourceRef("catalog", "agent-1", "release-1", "a".repeat(64), "workspace");
            var input = new ManagedAgentDefinitionSource.Definition(reference, "qwen-test", "Review.",
                    new ToolPolicy("hosted-workspace-files/1", "default"), List.of(), List.of(), List.of());
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
        }
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
        private final CyclicBarrier admitted = new CyclicBarrier(2);

        private RacingStore(ManagedDefinitionPreparationStore delegate) {
            this.delegate = delegate;
        }

        @Override
        public Preparation begin(String tenantId, String scopeId, String operationKey,
                String requestDigest, byte[] actorKey, long now) {
            var result = delegate.begin(tenantId, scopeId, operationKey, requestDigest, actorKey, now);
            try {
                admitted.await(10, TimeUnit.SECONDS);
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
            return result;
        }

        @Override
        public void resolve(String tenantId, String scopeId, String operationKey,
                ManagedAgentDefinitionSource.Definition input, String resultJson, long now) {
            delegate.resolve(tenantId, scopeId, operationKey, input, resultJson, now);
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
