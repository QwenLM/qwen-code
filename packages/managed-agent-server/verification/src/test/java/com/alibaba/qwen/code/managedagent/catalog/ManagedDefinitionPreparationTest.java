package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionPreparation.Command;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Current;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Exact;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.ExtensionUse;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.InlineSkill;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.PreRegistered;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource.BundleRef;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedAgentBootstrapPreparation;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ManagedDefinitionPreparationTest {
    private static final String TENANT = "tenant";
    private static final Instant DEADLINE = Instant.now().plusSeconds(60);
    private final ObjectMapper json = new ObjectMapper();
    private final ManagedAgentDefinitionSource source = mock(ManagedAgentDefinitionSource.class);
    private final AtomicLong calls = new AtomicLong();
    private final ManagedAgentBootstrapPreparation bundles = mock(ManagedAgentBootstrapPreparation.class);
    private JdbcTemplate jdbc;
    private ManagedDefinitionPreparationService service;
    private ManagedDefinitionSourceFixture fixture;
    private ManagedWorkspaceRegistry workspaces;

    @BeforeEach
    void setUp() throws Exception {
        org.mockito.Mockito.doAnswer(invocation -> ((List<BundleRef>) invocation.getArgument(1))
                .stream().map(bundle -> new ManagedAgentBootstrapPreparation.PreparedBundle(
                        bundle, bundle.expectedDigest(), bundle.expectedLength(), true)).toList())
                .when(bundles).prepare(any(), any());
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
                providers, new RequestDigests(), json, bundles);
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
                org.mockito.ArgumentMatchers.anyList(), org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyLong());
        var providers = new ManagedDefinitionInputProviders("SPI", provider(List.of(source)),
                provider(List.of()), workspaces);
        var definitions = new ManagedAgentDefinitionService(new JdbcManagedAgentDefinitionStore(jdbc,
                new RequestDigests()), new RequestDigests(), json);
        service = new ManagedDefinitionPreparationService(definitions, store, providers,
                new RequestDigests(), json, bundles);

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
                new JdbcDefinitionPreparationStore(jdbc, json), providers, new RequestDigests(), json, bundles);
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

    @Test
    void preparesADefinitionWithoutAModel() throws Exception {
        var input = new ManagedAgentDefinitionSource.Definition(fixture.ref(), null, "Review.",
                new ManagedAgentDefinitionSource.ToolPolicy("hosted-workspace-files/1", null),
                List.of(), List.of(), List.of());
        org.mockito.Mockito.doReturn(input).when(source).resolve(any(), eq(new Current("agent-1")));

        var first = service.prepare(command("operation-1", new Current("agent-1")));
        var replay = service.prepare(command("operation-1", new Current("agent-1")));

        assertThat(replay.definition()).isEqualTo(first.definition());
        var definition = json.readTree(jdbc.queryForObject("SELECT definition_json FROM ma_agent_definition",
                String.class));
        assertThat(definition.has("model")).isFalse();
        assertThat(definition.at("/permission_policy/approval_mode").isMissingNode()).isTrue();
        verify(source, times(1)).resolve(any(), eq(new Current("agent-1")));
    }

    @Test
    void settledPreparationAfterAResolveRaceDoesNotPrepareBundlesAgain() throws Exception {
        var race = race(new Current("agent-1"), input(fixture.ref()), input(fixture.ref()));
        var store = org.mockito.Mockito.spy(new JdbcDefinitionPreparationStore(jdbc, json));
        org.mockito.Mockito.doAnswer(invocation -> {
            invocation.callRealMethod();
            race.releaseFirst().countDown();
            return null;
        }).when(store).complete(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyString(),
                any(com.alibaba.qwen.code.managedagent.model.ApiModels.AgentDefinition.class),
                org.mockito.ArgumentMatchers.anyList(), org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyLong());
        usePreparations(store);
        org.mockito.Mockito.doAnswer(invocation -> List.of(
                new ManagedAgentBootstrapPreparation.PreparedBundle(fixture.bundle(),
                        fixture.bundle().expectedDigest(), fixture.bundle().expectedLength(), true)))
                .doThrow(new ManagedAgentException(403, "source_forbidden", "Source access was revoked."))
                .when(bundles).prepare(any(), any());

        try (var executor = Executors.newFixedThreadPool(2)) {
            var losing = executor.submit(() -> service.prepare(command("operation-1", new Current("agent-1"))));
            assertThat(race.firstEntered().await(10, TimeUnit.SECONDS)).isTrue();
            var winner = executor.submit(() -> service.prepare(command("operation-1", new Current("agent-1"))));

            assertThat(winner.get(30, TimeUnit.SECONDS).definition())
                    .isEqualTo(losing.get(30, TimeUnit.SECONDS).definition());
        } finally {
            race.releaseFirst().countDown();
        }
        verify(bundles, times(1)).prepare(any(), any());
    }

    @Test
    void concurrentCurrentSelectionsConvergeOnTheFirstSavedProjection() throws Exception {
        var later = new ManagedAgentDefinitionSource.SourceRef("catalog", "agent-1", "release-2",
                "c".repeat(64), "workspace");
        var race = race(new Current("agent-1"), input(fixture.ref()), input(later));
        var store = org.mockito.Mockito.spy(new JdbcDefinitionPreparationStore(jdbc, json));
        org.mockito.Mockito.doAnswer(invocation -> {
            invocation.callRealMethod();
            race.releaseFirst().countDown();
            return null;
        }).when(store).resolve(any(), any(), any(), any(), any(), org.mockito.ArgumentMatchers.anyLong());
        usePreparations(store);

        try (var executor = Executors.newFixedThreadPool(2)) {
            var losing = executor.submit(() -> service.prepare(command("operation-1", new Current("agent-1"))));
            assertThat(race.firstEntered().await(10, TimeUnit.SECONDS)).isTrue();
            var winner = executor.submit(() -> service.prepare(command("operation-1", new Current("agent-1"))));

            assertThat(losing.get(30, TimeUnit.SECONDS).definition())
                    .isEqualTo(winner.get(30, TimeUnit.SECONDS).definition());
        } finally {
            race.releaseFirst().countDown();
        }
        assertThat(jdbc.queryForObject("SELECT result_json FROM ma_request_receipt WHERE namespace = 'SOURCE_DEFINITION_PREPARATION'",
                String.class)).contains("\"sourceRevision\":\"release-2\"");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_agent_definition", Integer.class)).isOne();
    }

    @Test
    void concurrentExactSelectionsStillRejectChangedContent() throws Exception {
        var first = input(fixture.ref());
        var changed = new ManagedAgentDefinitionSource.Definition(fixture.ref(), "different-model",
                "Changed.", new ManagedAgentDefinitionSource.ToolPolicy("hosted-workspace-files/1", "default"),
                List.of(), List.of(), List.of());
        var race = race(new Exact(fixture.ref()), first, changed);
        var store = org.mockito.Mockito.spy(new JdbcDefinitionPreparationStore(jdbc, json));
        org.mockito.Mockito.doAnswer(invocation -> {
            invocation.callRealMethod();
            race.releaseFirst().countDown();
            return null;
        }).when(store).resolve(any(), any(), any(), any(), any(), org.mockito.ArgumentMatchers.anyLong());
        usePreparations(store);

        try (var executor = Executors.newFixedThreadPool(2)) {
            var losing = executor.submit(() -> service.prepare(command("operation-1", new Exact(fixture.ref()))));
            assertThat(race.firstEntered().await(10, TimeUnit.SECONDS)).isTrue();
            var winner = executor.submit(() -> service.prepare(command("operation-1", new Exact(fixture.ref()))));

            assertThat(winner.get(30, TimeUnit.SECONDS).definition()).isNotNull();
            assertThatThrownBy(() -> losing.get(30, TimeUnit.SECONDS))
                    .hasCauseInstanceOf(ManagedAgentException.class)
                    .cause().extracting(error -> ((ManagedAgentException) error).getCode())
                    .isEqualTo("definition_preparation_conflict");
        } finally {
            race.releaseFirst().countDown();
        }
    }

    @Test
    void resolvedPreparationCannotResumeAfterItsDeadline() {
        org.mockito.Mockito.doThrow(new ManagedAgentException(503, "result_unavailable", "Connection lost."))
                .doAnswer(invocation -> List.of(new ManagedAgentBootstrapPreparation.PreparedBundle(
                        fixture.bundle(), fixture.bundle().expectedDigest(),
                        fixture.bundle().expectedLength(), true)))
                .when(bundles).prepare(any(), any());
        assertThatThrownBy(() -> service.prepare(command("operation-1", new Current("agent-1"))))
                .isInstanceOf(ManagedAgentException.class);
        org.assertj.core.api.Assertions.assertThat(jdbc.queryForObject("SELECT state FROM ma_request_receipt WHERE namespace = 'SOURCE_DEFINITION_PREPARATION'",
                String.class)).isEqualTo("RESOLVED");
        var expired = new Command(TENANT, "actor", "workspace", "workspace", "operation-1",
                new Current("agent-1"), Instant.now().minusSeconds(1));

        assertThatThrownBy(() -> service.prepare(expired))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode())
                        .isEqualTo("definition_preparation_deadline_exceeded"));
        verify(bundles, times(1)).prepare(any(), any());
    }

    private SourceRace race(ManagedAgentDefinitionSource.Selection selection,
            ManagedAgentDefinitionSource.Definition first, ManagedAgentDefinitionSource.Definition second) {
        var firstEntered = new CountDownLatch(1);
        var releaseFirst = new CountDownLatch(1);
        org.mockito.Mockito.doAnswer(invocation -> {
            if (calls.incrementAndGet() == 1) {
                firstEntered.countDown();
                if (!releaseFirst.await(10, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("Source race was not released");
                }
                return first;
            }
            return second;
        }).when(source).resolve(any(), eq(selection));
        return new SourceRace(firstEntered, releaseFirst);
    }

    private void usePreparations(JdbcDefinitionPreparationStore preparations) {
        var definitions = new ManagedAgentDefinitionService(new JdbcManagedAgentDefinitionStore(jdbc,
                new RequestDigests()), new RequestDigests(), json);
        var providers = new ManagedDefinitionInputProviders("SPI", provider(List.of(source)),
                provider(List.of()), workspaces);
        service = new ManagedDefinitionPreparationService(definitions, preparations,
                providers, new RequestDigests(), json, bundles);
    }

    private record SourceRace(CountDownLatch firstEntered, CountDownLatch releaseFirst) {
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
