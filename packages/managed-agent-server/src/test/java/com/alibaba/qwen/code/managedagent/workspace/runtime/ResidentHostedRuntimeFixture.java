package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.persistence.ResidentWorkspaces;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiReservationStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.provisioning.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.transport.HttpRuntimeTransport;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.support.AbstractBeanDefinition;
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationInitializer;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;

/** Test placement only: boot 2 and an ordinary directory; never a CSI Pod or mount. */
public final class ResidentHostedRuntimeFixture implements RuntimeProvisioner {
    private final ManagedAgentProperties.RuntimeBroker.ResidentWorkspace mapping;
    private final ResidentWorkspaces residents;
    private final WorkspaceCsiReservationStore storage;
    private final JdbcRuntimeBindingRepository bindings;
    private final Placement placement;
    private final boolean ownsPlacement;
    public final AtomicInteger starts;
    public final AtomicInteger physicalReleases;

    public static final class Placement implements AutoCloseable {
        private final LocalProcessRuntimeProvisioner delegate;
        private final RuntimeResourceHandle handle = new RuntimeResourceHandle("kubernetes-workspace", 1,
                Map.of("fixture", "ordinary-darwin-boot2", "fixtureId", UUID.randomUUID().toString()));
        private RuntimeProvisionRequest request;
        private RuntimeProvisionSeed seed;
        private volatile RuntimeLease lease;
        private CompletionStage<RuntimeLease> started;
        private final AtomicInteger starts = new AtomicInteger();
        private final AtomicInteger physicalReleases = new AtomicInteger();

        public Placement(List<String> command, Path processDirectory) {
            delegate = new LocalProcessRuntimeProvisioner(command, processDirectory, new HttpRuntimeTransport());
        }

        @Override public void close() { delegate.close(); }
    }

    public static void arguments(List<String> arguments, String tenant, Path root) {
        String p = "--qwen.managed-agent.runtime-broker.";
        for (var entry : Map.of("provisioner", "kubernetes-workspace", "isolation-class", "workspace",
                "workspace-id", "unused-global-workspace",
                "verified-workspace-recovery-enabled", "false", "child-workspaces-enabled", "false",
                "resident-kubernetes-api-url", "https://127.0.0.1:9",
                "resident-kubernetes-token-file", "/fixture-not-read-token",
                "resident-kubernetes-ca-file", "/fixture-not-read-ca").entrySet()) {
            arguments.removeIf(argument -> argument.startsWith(p + entry.getKey() + "="));
            arguments.add(p + entry.getKey() + "=" + entry.getValue());
        }
        String r = p + "resident-workspaces[0].";
        var values = new java.util.LinkedHashMap<String, String>();
        values.put("workspace-id", "workspace-0");
        values.put("workspace-generation", "1");
        values.put("registration.tenant-id", tenant);
        values.put("registration.storage-id", "storage-0");
        values.put("registration.cluster-domain", "ordinary-fixture");
        values.put("registration.namespace", "fixture");
        values.put("registration.pvc-name", "claim");
        values.put("registration.pvc-uid", "fixture-pvc");
        values.put("registration.pv-name", "volume");
        values.put("registration.pv-uid", "fixture-pv");
        values.put("registration.driver", "fixture.csi.example");
        values.put("registration.volume-handle", "fixture-handle");
        values.put("registration.backend-domain", "fixture-backend");
        values.put("registration.disk-serial", "fixture-serial");
        values.put("registration.mount-root", root.toString());
        values.put("registration.revision", "1");
        values.put("protection.namespace-uid", "fixture-namespace");
        values.put("protection.policy-name", "fixture-policy");
        values.put("protection.policy-uid", "fixture-policy-uid");
        values.put("protection.policy-generation", "1");
        values.put("protection.binding-name", "fixture-binding");
        values.put("protection.binding-uid", "fixture-binding-uid");
        values.put("protection.binding-generation", "1");
        values.put("image", "worker@sha256:" + "a".repeat(64));
        values.put("artifacts", "");
        values.put("command[0]", "node");
        values.put("command[1]", "/fixture-not-consumed-cli.js");
        values.forEach((key, value) -> arguments.add(r + key + "=" + value));
    }

    public static void install(ConfigurableApplicationContext context, List<String> command, Path processDirectory) {
        install(context, command, processDirectory, null);
    }

    public static void install(ConfigurableApplicationContext context, List<String> command, Path processDirectory,
            Placement retainedPlacement) {
        context.addBeanFactoryPostProcessor(factory -> {
            var definition = (AbstractBeanDefinition) factory.getBeanDefinition("embeddedRuntimeBroker");
            if (!"embeddedRuntimeBroker".equals(definition.getFactoryMethodName())) {
                throw new IllegalStateException("Original Embedded Broker definition is required");
            }
            definition.setInstanceSupplier(() -> {
                // Complete the real canonical migrations before registering fixture data.
                factory.getBean(FlywayMigrationInitializer.class);
                var properties = factory.getBean(ManagedAgentProperties.class);
                var jdbc = factory.getBean(JdbcTemplate.class);
                var manager = factory.getBean(PlatformTransactionManager.class);
                var bindings = (JdbcRuntimeBindingRepository) factory.getBean(RuntimeBindingRepository.class);
                if (!bindings.usesDataSource(jdbc.getDataSource())) {
                    throw new IllegalStateException("Original DataSource required");
                }
                var fixture = new ResidentHostedRuntimeFixture(properties, jdbc, manager, bindings, command,
                        processDirectory, retainedPlacement);
                factory.registerSingleton("residentHostedFixture", fixture);
                return new EmbeddedRuntimeBroker(factory.getBean(AgentStateStore.class), properties, bindings,
                        factory.getBean(RuntimeSessionRepository.class), factory.getBean(ToolExecutionRepository.class),
                        factory.getBean(WorkspaceExecutionStore.class), factory.getBeanProvider(ToolPublicationStore.class).getIfAvailable(),
                        factory.getBeanProvider(ToolPublicationDataStore.class).getIfAvailable(), jdbc, manager, fixture);
            });
        });
    }

    private ResidentHostedRuntimeFixture(ManagedAgentProperties properties, JdbcTemplate jdbc,
            PlatformTransactionManager manager, JdbcRuntimeBindingRepository bindings,
            List<String> command, Path processDirectory, Placement retainedPlacement) {
        var configured = properties.getRuntimeBroker().getResidentWorkspaces();
        if (configured.size() != 1) {
            throw new IllegalArgumentException("One fixture Workspace required");
        }
        mapping = configured.getFirst();
        residents = new ResidentWorkspaces(configured);
        this.bindings = bindings;
        storage = new WorkspaceCsiReservationStore(jdbc, manager, new ObjectMapper());
        storage.register(mapping.registration());
        ResidentWorkspaces.requireRegistration(jdbc, mapping);
        ownsPlacement = retainedPlacement == null;
        placement = ownsPlacement ? new Placement(command, processDirectory) : retainedPlacement;
        starts = placement.starts;
        physicalReleases = placement.physicalReleases;
    }

    public static com.fasterxml.jackson.databind.JsonNode snapshot(JdbcTemplate jdbc, String sql, Object... args) {
        var rows = jdbc.queryForList(sql, args);
        for (var row : rows) {
            row.replaceAll((key, value) -> {
                try {
                    if (value instanceof byte[] bytes) {
                        return Map.of("type", "bytes", "value", java.util.Base64.getEncoder().encodeToString(bytes));
                    }
                    if (value instanceof java.sql.Blob blob) {
                        return Map.of("type", "blob", "value", java.util.Base64.getEncoder().encodeToString(blob.getBytes(1, Math.toIntExact(blob.length()))));
                    }
                    if (value instanceof java.sql.Clob clob) {
                        return Map.of("type", "clob", "value", clob.getSubString(1, Math.toIntExact(clob.length())));
                    }
                    if (value instanceof java.sql.Timestamp timestamp) {
                        return Map.of("type", "timestamp", "value", timestamp.toLocalDateTime().toString(), "nanos", timestamp.getNanos());
                    }
                    if (value instanceof java.math.BigDecimal decimal) {
                        return Map.of("type", "decimal", "value", decimal.toPlainString());
                    }
                    if (value instanceof java.time.temporal.TemporalAccessor || value instanceof java.util.Date) {
                        return Map.of("type", value.getClass().getName(), "value", value.toString());
                    }
                    if (value == null || value instanceof String || value instanceof Number || value instanceof Boolean) {
                        return value;
                    }
                    throw new IllegalArgumentException("Unexpected fixture JDBC type " + value.getClass().getName());
                } catch (java.sql.SQLException error) {
                    throw new IllegalStateException(error);
                }
            });
        }
        return new ObjectMapper().valueToTree(rows);
    }

    public static void assertConflict(Runnable call) {
        Throwable error = org.assertj.core.api.Assertions.catchThrowable(call::run);
        while (error instanceof java.util.concurrent.CompletionException && error.getCause() != null) {
            error = error.getCause();
        }
        org.assertj.core.api.Assertions.assertThat(error).isInstanceOf(RuntimeBrokerException.class);
        org.assertj.core.api.Assertions.assertThat(((RuntimeBrokerException) error).getStatusCode()).isEqualTo(409);
    }

    @Override public String kind() { return "kubernetes-workspace"; }
    @Override public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
        residents.require(scope);
        if (isolationKey != null) {
            throw new IllegalArgumentException("Shared fixture has no isolation key");
        }
        return new RuntimeProvisionRequest(scope, null, kind(), mapping.registration().storageId());
    }
    @Override public void reserveResource(RuntimeBindingRecord original) {
        String value = "qwen-csi-reservation/1:" + mapping.registration().aliasKey() + ":"
                + mapping.registration().revision() + ":" + original.getProvisionSeed().getProvisionRequestId();
        storage.reserve(mapping.registration(), bindings, original,
                UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8)).toString());
    }
    private void remember(RuntimeProvisionRequest actual, RuntimeProvisionSeed actualSeed) {
        residents.require(actual.getScope());
        synchronized (placement) {
            if (!ResidentWorkspaceProfile.selects(actual) || !mapping.registration().storageId().equals(actual.getStorageId())
                    || placement.request != null && (!placement.request.equals(actual) || !placement.seed.equals(actualSeed))) {
                throw new IllegalStateException("Fixture cannot replace its original request or seed");
            }
            placement.request = actual;
            placement.seed = actualSeed;
        }
    }
    @Override public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
        remember(request, seed);
        if (knownHandle != null && !placement.handle.equals(knownHandle)) {
            throw new IllegalStateException("Fixture handle differs");
        }
        return CompletableFuture.completedFuture(placement.handle);
    }
    @Override public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
        return CompletableFuture.failedFuture(new IllegalStateException("Persisted seed required"));
    }
    @Override public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        remember(request, seed);
        synchronized (placement) {
            if (placement.started == null) {
                starts.incrementAndGet();
                placement.started = placement.delegate.provision(request, seed).thenApply(actual -> {
                    placement.lease = actual;
                    return actual;
                });
            }
            return placement.started;
        }
    }
    @Override public CompletionStage<RuntimeObservation> reconcile(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lastLease) {
        remember(request, seed);
        if (!placement.handle.equals(handle) || !sameLease(placement.lease, lastLease)
                || !placement.delegate.isUsable(placement.lease)) {
            return CompletableFuture.completedFuture(RuntimeObservation.unknown(handle));
        }
        return placement.delegate.confirm(request, placement.lease).thenApply(ignored -> RuntimeObservation.ready(handle,
                placement.lease.getEndpoint(), placement.lease.getRuntimeInstanceId(), placement.lease.getLeaseId(),
                placement.lease.getEpoch()));
    }
    @Override public CompletionStage<Void> confirm(RuntimeProvisionRequest request, RuntimeLease lease) {
        if (!placement.request.equals(request) || !sameLease(placement.lease, lease)) {
            throw new IllegalStateException("Original lease required");
        }
        return placement.delegate.confirm(request, lease);
    }
    @Override public boolean isUsable(RuntimeLease lease) {
        return sameLease(placement.lease, lease) && placement.delegate.isUsable(lease);
    }
    @Override public CompletionStage<Void> release(RuntimeProvisionRequest request, RuntimeLease lease) {
        physicalReleases.incrementAndGet();
        return CompletableFuture.failedFuture(new AssertionError("Public resident lifecycle must not stop placement"));
    }
    public boolean workerAlive() { return placement.lease != null && placement.delegate.isUsable(placement.lease); }
    private static boolean sameLease(RuntimeLease a, RuntimeLease b) {
        return a != null && b != null && a.getRuntimeInstanceId().equals(b.getRuntimeInstanceId())
                && a.getEndpoint().equals(b.getEndpoint()) && a.getToken().equals(b.getToken())
                && a.getLeaseId().equals(b.getLeaseId()) && a.getEpoch() == b.getEpoch();
    }
    @Override public void close() {
        if (ownsPlacement) {
            placement.close();
        }
    }
}
