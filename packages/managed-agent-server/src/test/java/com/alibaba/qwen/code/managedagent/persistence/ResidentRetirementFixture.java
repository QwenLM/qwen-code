package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.managedagent.event.CommittedEventPublisher;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceCsiResourceGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.provisioning.KubernetesHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.digest;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.map;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

final class ResidentRetirementFixture {
    private static final String UID = "11111111-1111-4111-8111-111111111111";
    private static final ObjectMapper JSON = new ObjectMapper();
    final DataSource source;
    final ManagedSchemaJdbcTemplate jdbc;
    final DataSourceTransactionManager manager;
    final JdbcRuntimeBindingRepository bindings;
    final WorkspaceCsiReservationStore storage;
    final ResidentWorkspace mapping;
    final ResidentWorkspaceRetirementStore.Request request;
    final RuntimeProvisionRequest runtimeRequest;
    final Map<String, Map<String, Object>> objects = new LinkedHashMap<>();
    RuntimeBindingRecord original;
    private final ManagedAgentProperties properties = new ManagedAgentProperties();

    ResidentRetirementFixture(DataSource source) {
        this.source = source;
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        mapping = new ResidentWorkspace("workspace", 1,
                new WorkspaceCsiRegistration("tenant", "storage", "cluster", "runtime", "claim", "pvc-uid",
                        "volume", "pv-uid", "diskplugin.csi.alibabacloud.com", "handle", "backend", "serial", "/workspace", 1),
                new WorkspaceCsiResourceGuard.ProtectionIdentity(UID, "protect", UID, 1, "protect-binding", UID, 1),
                "worker@sha256:" + "a".repeat(64), List.of("node", "/worker/cli.js"), List.of());
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getRuntimeBroker().setResidentWorkspaces(List.of(mapping));
        request = new ResidentWorkspaceRetirementStore.Request("tenant", "workspace", 1, "owner", UUID.randomUUID().toString());
        runtimeRequest = new RuntimeProvisionRequest(ResidentWorkspaces.scope(mapping), null, "kubernetes-workspace", "storage");
        storage = new WorkspaceCsiReservationStore(jdbc, manager, JSON);
        storage.register(mapping.registration());
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name,"
                + " config_ref, policy_ref, state) VALUES ('tenant', 'workspace', 1, 'storage', 'resident', ?, ?, 'ACTIVE')",
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES ('tenant', 'workspace', ?, 'OWNER')", ManagedWorkspaceRegistry.actorKey("tenant", "owner"));
    }

    ResidentWorkspaceRetirementStore store() {
        return new ResidentWorkspaceRetirementStore(jdbc, manager, bindings, List.of(mapping), JSON);
    }

    StoreModels.Admission create(String key) {
        var store = new ManagedAgentStore(jdbc, JSON, Clock.systemUTC(), mock(CommittedEventPublisher.class),
                new ManagedWorkspaceRegistry(jdbc), properties);
        return new TransactionTemplate(manager).execute(status -> store.insertWorkspaceSessionCommand("tenant", "owner", key,
                "digest-" + key, "qwen-code", null, "Session", List.of(), null, new WorkspaceSelection("workspace", ".")));
    }

    RuntimeBindingRecord ready() {
        if (original != null) {
            return original;
        }
        var created = bindings.findOrCreate(runtimeRequest);
        var claimed = bindings.claimOperation(created.getBindingId(), "setup", Duration.ofMinutes(5));
        var reserved = storage.reserve(mapping.registration(), bindings, claimed, UUID.randomUUID().toString());
        var seed = claimed.getProvisionSeed();
        var registration = mapping.registration();
        var tuple = new LinkedHashMap<String, Object>();
        tuple.putAll(Map.of("clusterDomain", registration.clusterDomain(), "namespace", registration.namespace(),
                "backendDomain", registration.backendDomain(), "driver", registration.driver(), "volumeHandle", registration.volumeHandle(),
                "diskSerial", registration.diskSerial(), "physicalKey", registration.physicalKey(), "pvcUid", registration.pvcUid(),
                "pvUid", registration.pvUid(), "registrationRevision", "1"));
        tuple.putAll(Map.of("reservationId", reserved.reservationId(), "reservationRevision", "1"));
        String name = WorkspaceCsiRuntimeIdentity.name(seed);
        var placement = new LinkedHashMap<String, Object>();
        placement.putAll(Map.of("clusterDomain", "cluster", "namespace", "runtime", "namespaceUid", UID,
                "podName", name, "podUid", UID, "nodeName", "node-a", "nodeUid", UID));
        placement.putAll(Map.of("containerName", "runtime", "containerId", "containerd://" + "b".repeat(64),
                "image", mapping.image(), "imageId", "sha256:" + "a".repeat(64), "podIp", "10.4.0.8",
                "secretName", name, "secretUid", UID));
        var protection = Map.<String, Object>of("namespaceUid", UID, "policyName", "protect", "policyUid", UID,
                "policyGeneration", "1", "bindingName", "protect-binding", "bindingUid", UID, "bindingGeneration", "1");
        var spec = Map.<String, Object>of("nodeName", "node-a", "restartPolicy", "Never", "containers",
                List.of(Map.of("name", "runtime", "image", mapping.image(), "command", mapping.command(), "volumeMounts",
                        List.of(Map.of("name", "workspace", "mountPath", "/workspace")))), "volumes",
                List.of(Map.of("name", "workspace", "persistentVolumeClaim", Map.of("claimName", "claim"))));
        var boot = WorkspaceCsiRuntimeIdentity.boot(runtimeRequest, seed, tuple);
        var identity = new LinkedHashMap<String, Object>();
        identity.putAll(Map.of("bindingId", claimed.getBindingId(), "runtimeGeneration", "1",
                "context", WorkspaceCsiRuntimeIdentity.context(boot), "storage", tuple, "placement", placement,
                "protection", protection, "artifacts", List.of(), "bootDigest", digest(boot), "podSpecDigest", digest(spec),
                "mount", Map.of("mountId", "9", "device", "259:1", "source", "/dev/nvme1n1", "diskSerial", "serial",
                        "rootDevice", "66305", "rootInode", "2")));
        identity.put("identity", digest(identity));
        var attested = bindings.compareAndSet(claimed, claimed.withAttestation(WorkspaceCsiRuntimeIdentity.lease(seed, placement),
                new RuntimeResourceHandle("kubernetes-workspace", 1, identity), Instant.now(), Instant.now()));
        original = bindings.releaseOperation(attested.getBindingId(), "setup", attested.getOperationGeneration());
        WorkspaceCsiRuntimeIdentity.verify(original);
        objects.put("pods", object("Pod", name, "runtime", UID, spec));
        objects.get("pods").put("status", copy(Map.of("phase", "Running", "podIP", "10.4.0.8", "containerStatuses",
                List.of(Map.of("name", "runtime", "containerID", placement.get("containerId"), "imageID", placement.get("imageId"),
                        "restartCount", 0, "ready", true, "state", Map.of("running", Map.of()))))));
        objects.put("nodes", object("Node", "node-a", null, UID, Map.of()));
        objects.get("nodes").put("status", copy(Map.of("conditions", List.of(Map.of("type", "Ready", "status", "True")))));
        resources();
        return original;
    }

    KubernetesHttpRuntimeClient api() {
        var api = mock(KubernetesHttpRuntimeClient.class);
        when(api.get(anyString(), anyString(), anyString())).thenAnswer(call ->
                CompletableFuture.completedFuture(objects.get(call.<String>getArgument(0))));
        when(api.getCluster(anyString(), anyString())).thenAnswer(call ->
                CompletableFuture.completedFuture(objects.get(call.<String>getArgument(0))));
        when(api.deletePod(anyString(), anyString(), any(byte[].class))).thenReturn(
                CompletableFuture.completedFuture(new KubernetesHttpRuntimeClient.DeleteResponse(200, new byte[0], true)));
        return api;
    }

    void resourceVersion(String version) {
        map(objects.get("pods").get("metadata")).put("resourceVersion", version);
    }

    List<Map<String, Object>> attempts() {
        return jdbc.query("SELECT * FROM ma_operation_work WHERE work_kind = 'POD_DELETE_ATTEMPT' ORDER BY target_key",
                (row, index) -> WorkspaceOperations.work(row));
    }

    private void resources() {
        var registration = mapping.registration();
        objects.put("persistentvolumeclaims", object("PersistentVolumeClaim", "claim", "runtime", "pvc-uid",
                Map.of("volumeName", "volume", "volumeMode", "Filesystem", "accessModes", List.of("ReadWriteOncePod"))));
        objects.put("persistentvolumes", object("PersistentVolume", "volume", null, "pv-uid",
                Map.of("volumeMode", "Filesystem", "accessModes", List.of("ReadWriteOncePod"),
                        "claimRef", Map.of("apiVersion", "v1", "kind", "PersistentVolumeClaim", "name", "claim", "namespace", "runtime", "uid", "pvc-uid"),
                        "csi", Map.of("driver", registration.driver(), "volumeHandle", "handle", "fsType", "ext4"))));
        objects.put("namespaces", object("Namespace", "runtime", null, UID, Map.of()));
        map(objects.get("namespaces").get("metadata")).put("labels", Map.of("pod-security.kubernetes.io/enforce", "restricted",
                "pod-security.kubernetes.io/enforce-version", "v1.36"));
        objects.get("namespaces").put("status", Map.of("phase", "Active"));
        var policy = copy(WorkspaceCsiResourceGuard.policy(registration, "protect"));
        map(policy.get("metadata")).putAll(Map.of("uid", UID, "generation", 1, "resourceVersion", "12"));
        policy.put("status", Map.of("observedGeneration", 1, "typeChecking", Map.of()));
        objects.put("validatingadmissionpolicies", policy);
        var binding = copy(WorkspaceCsiResourceGuard.binding("protect", "protect-binding"));
        map(binding.get("metadata")).putAll(Map.of("uid", UID, "generation", 1, "resourceVersion", "13"));
        objects.put("validatingadmissionpolicybindings", binding);
    }

    private static Map<String, Object> object(String kind, String name, String namespace, String uid, Map<String, Object> spec) {
        var metadata = new LinkedHashMap<String, Object>(Map.of("name", name, "uid", uid, "resourceVersion", "10"));
        if (namespace != null) {
            metadata.put("namespace", namespace);
        }
        return copy(Map.of("apiVersion", "v1", "kind", kind, "metadata", metadata, "spec", spec, "status", Map.of("phase", "Bound")));
    }

    private static Map<String, Object> copy(Map<String, Object> value) {
        return JSON.convertValue(value, new TypeReference<>() { });
    }
}
