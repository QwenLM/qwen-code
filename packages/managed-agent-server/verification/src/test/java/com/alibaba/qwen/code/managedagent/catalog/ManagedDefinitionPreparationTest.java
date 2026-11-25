package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionPreparation.Command;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Current;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Exact;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.ExtensionUse;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.InlineSkill;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.PreRegistered;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource.BundleRef;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Target;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionSource;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.AgentDefinitionRequest;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.JdbcDefinitionPreparationStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ManagedDefinitionPreparationTest {
    private static final String TENANT = "tenant";
    private static final Instant DEADLINE = Instant.now().plusSeconds(60);
    private final ObjectMapper json = new ObjectMapper();
    private final ManagedAgentDefinitionSource source = mock(ManagedAgentDefinitionSource.class);
    private final AtomicLong calls = new AtomicLong();
    private JdbcTemplate jdbc;
    private ManagedDefinitionPreparationService service;
    private ManagedDefinitionSourceFixture fixture;
    private ManagedWorkspaceRegistry workspaces;

    @BeforeEach
    void setUp() throws Exception {
        var dataSource = new DriverManagerDataSource("jdbc:h2:mem:definition-preparation-"
                + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(dataSource);
        jdbc = new JdbcTemplate(dataSource);
        var definitions = new ManagedAgentDefinitionService(
                new JdbcManagedAgentDefinitionStore(jdbc, new RequestDigests()),
                new RequestDigests(), json);
        workspaces = mock(ManagedWorkspaceRegistry.class);
        when(workspaces.accessOf(TENANT, "actor", "workspace")).thenReturn(WorkspaceAccess.OPERATOR);
        when(source.id()).thenReturn("catalog");
        var providers = new ManagedDefinitionInputProviders("SPI",
                provider(List.of(source)), provider(List.of()), workspaces);
        var preparations = new JdbcDefinitionPreparationStore(jdbc, json);
        service = new ManagedDefinitionPreparationService(definitions, preparations,
                providers, new RequestDigests(), json);
        ManagedAgentDefinitionSource.SourceRef ref = new ManagedAgentDefinitionSource.SourceRef(
                "catalog", "agent-1", "release-1", "a".repeat(64), "workspace");
        fixture = new ManagedDefinitionSourceFixture(ref, new ExtensionUse(
                new ManagedExtensionSource.Reference("catalog", "extension", "suite-1", "release-1"),
                new Target("linux", "x64")), new BundleRef("catalog", "bundle-1", "release-1",
                "b".repeat(64), 4096L));
        when(source.resolve(any(), eq(new Current("agent-1")))).thenAnswer(invocation -> {
            calls.incrementAndGet();
            assertThat(jdbc.queryForObject("SELECT state FROM ma_request_receipt"
                    + " WHERE namespace = 'SOURCE_DEFINITION_PREPARATION'", String.class)).isEqualTo("PENDING");
            return input(ref);
        });
    }

    @Test
    void preparesTheExactNativeProjectionAndReplaysWithoutResolvingAgain() throws Exception {
        var first = service.prepare(command("operation-1", new Current("agent-1")));
        var replay = service.prepare(command("operation-1", new Current("agent-1")));

        assertThat(replay.definition()).isEqualTo(first.definition());
        assertThat(replay.operation().operationKey()).isEqualTo(first.operation().operationKey());
        assertThat(replay.operation().replayed()).isTrue();
        assertThat(calls).hasValue(1);
        String result = jdbc.queryForObject("SELECT result_json FROM ma_request_receipt"
                + " WHERE namespace = 'SOURCE_DEFINITION_PREPARATION'", String.class);
        var saved = json.readTree(result);
        assertThat(saved.at("/input/ref/sourceRevision").asText()).isEqualTo("release-1");
        assertThat(saved.at("/definition/id").asText()).isEqualTo(first.definition().id());
        String definition = jdbc.queryForObject("SELECT definition_json FROM ma_agent_definition"
                + " WHERE agent_id = ?", String.class, first.definition().id());
        var value = json.readTree(definition);
        assertThat(value.at("/model/id").asText()).isEqualTo("qwen-test");
        assertThat(value.at("/tools/0/type").asText()).isEqualTo("hosted_profile");
        assertThat(value.at("/tools/0/profile").asText()).isEqualTo("hosted-workspace-files/1");
        assertThat(value.at("/permission_policy/approval_mode").asText()).isEqualTo("default");
        assertThat(value.at("/skills/0/base_directory").asText()).isEqualTo(".qwen/skills/review");
        assertThat(value.at("/metadata/sourceProjection/projectionDigest").asText()).isEqualTo("a".repeat(64));
        assertThat(value.at("/metadata/suites/0/source/resourceId").asText()).isEqualTo("suite-1");
        assertThat(definitionsMetadata(first)).isEqualTo(fixture.ref());
    }

    @Test
    void exactAuthorizationDoesNotCreateAnotherNativeDefinition() {
        var first = service.prepare(command("operation-1", new Current("agent-1")));
        org.mockito.Mockito.doAnswer(invocation -> input(fixture.ref()))
                .when(source).resolve(any(), eq(new Exact(fixture.ref())));

        var second = service.prepare(command("operation-2", new Exact(fixture.ref())));

        assertThat(second.definition()).isEqualTo(first.definition());
        verify(source).resolve(any(), eq(new Exact(fixture.ref())));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_agent_definition", Integer.class)).isOne();
    }

    @Test
    void resumingAnUnresolvedExactCommandNeverReplacesItWithCurrentContent() {
        org.mockito.Mockito.doAnswer(invocation -> {
            assertThat(jdbc.queryForObject("SELECT state FROM ma_request_receipt"
                    + " WHERE namespace = 'SOURCE_DEFINITION_PREPARATION'", String.class)).isEqualTo("PENDING");
            return input(new ManagedAgentDefinitionSource.SourceRef("catalog", "agent-1", "release-2",
                    "c".repeat(64), "workspace"));
        }).when(source).resolve(any(), eq(new Exact(fixture.ref())));

        assertThatThrownBy(() -> service.prepare(command("operation-1", new Exact(fixture.ref()))))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("source_projection_conflict"));
    }

    @Test
    void rejectsChangedContentUnderTheSameExactProjection() {
        service.prepare(command("operation-1", new Current("agent-1")));
        org.mockito.Mockito.doAnswer(invocation -> new ManagedAgentDefinitionSource.Definition(fixture.ref(),
                        "different-model", "Changed.", new ManagedAgentDefinitionSource.ToolPolicy(
                                "hosted-workspace-files/1", "default"),
                        List.of(), List.of(fixture.suite()), List.of(fixture.bundle())))
                .when(source).resolve(any(), eq(new Exact(fixture.ref())));

        assertThatThrownBy(() -> service.prepare(command("operation-2", new Exact(fixture.ref()))))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("source_projection_conflict"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_agent_definition", Integer.class)).isOne();
    }

    @Test
    void sameOperationKeyCannotSelectAnotherInput() {
        service.prepare(command("operation-1", new Current("agent-1")));
        var different = new ManagedAgentDefinitionSource.SourceRef("catalog", "agent-1", "release-2",
                "c".repeat(64), "workspace");

        assertThatThrownBy(() -> service.prepare(command("operation-1", new Exact(different))))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        verify(source, never()).resolve(any(), eq(new Exact(different)));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_agent_definition", Integer.class)).isOne();
    }

    @Test
    void readsSettledDefinitionAfterLosingTheCompletionResponse() {
        var original = new JdbcDefinitionPreparationStore(jdbc, json);
        var store = org.mockito.Mockito.spy(original);
        org.mockito.Mockito.doAnswer(invocation -> {
            invocation.callRealMethod();
            throw new ManagedAgentException(503, "result_unavailable", "Connection lost.");
        }).when(store).complete(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyString(),
                any(com.alibaba.qwen.code.managedagent.model.ApiModels.AgentDefinition.class),
                org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyLong());
        var providers = new ManagedDefinitionInputProviders("SPI", provider(List.of(source)),
                provider(List.of()), workspaces);
        var definitions = new ManagedAgentDefinitionService(new JdbcManagedAgentDefinitionStore(jdbc,
                new RequestDigests()), new RequestDigests(), json);
        service = new ManagedDefinitionPreparationService(definitions, store, providers,
                new RequestDigests(), json);

        var result = service.prepare(command("operation-1", new Current("agent-1")));

        assertThat(result.operation().replayed()).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_agent_definition", Integer.class)).isOne();
    }

    @Test
    void preRegisteredInputDoesNotRequireAProvider() throws Exception {
        var providers = new ManagedDefinitionInputProviders("PRE_REGISTERED", provider(List.of()),
                provider(List.of()), workspaces);
        var definitions = new ManagedAgentDefinitionService(new JdbcManagedAgentDefinitionStore(jdbc,
                new RequestDigests()), new RequestDigests(), json);
        service = new ManagedDefinitionPreparationService(definitions,
                new JdbcDefinitionPreparationStore(jdbc, json), providers, new RequestDigests(), json);
        var request = new AgentDefinitionRequest(Map.of("id", "qwen-test"), "Review.",
                List.of(Map.of("name", "read_file")), null, null, null,
                Map.of("approval_mode", "default"), null, null);

        var result = service.prepare(command("pre-registered", new PreRegistered(request)));
        var replay = service.prepare(command("pre-registered", new PreRegistered(request)));

        assertThat(result.definition().id()).matches("agent_[0-9a-f]{32}");
        assertThat(replay.definition()).isEqualTo(result.definition());
        assertThat(replay.operation().replayed()).isTrue();
        verify(source, never()).resolve(any(), any());
        assertThat(json.readTree(jdbc.queryForObject("SELECT result_json FROM ma_request_receipt"
                + " WHERE namespace = 'SOURCE_DEFINITION_PREPARATION'", String.class)).has("input")).isFalse();
    }

    private Command command(String operation, ManagedAgentDefinitionSource.Selection selection) {
        return new Command(TENANT, "actor", "workspace", "workspace", operation, selection, DEADLINE);
    }

    private ManagedAgentDefinitionSource.Definition input(ManagedAgentDefinitionSource.SourceRef ref) {
        return new ManagedAgentDefinitionSource.Definition(ref, "qwen-test", "Review the diff.",
                new ManagedAgentDefinitionSource.ToolPolicy("hosted-workspace-files/1", "default"),
                List.of(new InlineSkill("review", "Review changes", "Read the diff.", ".qwen/skills/review"),
                        new ExtensionUse(new ManagedExtensionSource.Reference("catalog", "skill", "review", "v1"),
                                new Target("linux", "x64"))),
                List.of(fixture.suite()), List.of(fixture.bundle()));
    }

    private ManagedAgentDefinitionSource.SourceRef definitionsMetadata(
            com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionPreparation.PrepareReceipt receipt) {
        return json.convertValue(receipt.definition().metadata().get("sourceProjection"),
                ManagedAgentDefinitionSource.SourceRef.class);
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(List<T> providers) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.orderedStream()).thenReturn(providers.stream());
        return provider;
    }

    private record ManagedDefinitionSourceFixture(ManagedAgentDefinitionSource.SourceRef ref,
            ExtensionUse suite, BundleRef bundle) {
    }
}
