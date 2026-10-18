package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.SshRuntimeSettings;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.SshWorkspaceStore;
import com.alibaba.qwen.code.managedagent.store.SshWorkspaceStore.Intent;
import com.alibaba.qwen.code.managedagent.store.SshWorkspaceStore.Operation;
import com.alibaba.qwen.code.managedagent.store.SshWorkspaceStore.Parked;
import com.alibaba.qwen.code.managedagent.store.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.SshConnectionManager;
import com.alibaba.qwen.code.runtimebroker.SshRuntimeNode;
import com.alibaba.qwen.code.runtimebroker.SshRuntimeStorage;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import jakarta.annotation.PreDestroy;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.net.URI;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * SSH Workspace registration. It is also the D7-2 evidence source for a
 * registration parked recovery_blocked: only the registration's node can say
 * whether its marker landed, and it is read, never written again.
 */
@Service
public class SshWorkspaceService implements AutoCloseable, AcceptanceEvidence {
    private final ManagedAgentProperties properties;
    private final SshWorkspaceStore store;
    private final Clock clock;
    private final Map<String, SshRuntimeSettings.Node> nodes;
    private final SshConnectionManager connections;
    private final Set<String> running = ConcurrentHashMap.newKeySet();
    private final ThreadPoolExecutor executor = new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(32), Thread.ofPlatform().daemon().name("ssh-workspace-", 0).factory());

    @org.springframework.beans.factory.annotation.Autowired
    public SshWorkspaceService(ManagedAgentProperties properties, SshWorkspaceStore store, Clock clock) {
        this(properties, store, properties.getRuntimeBroker().getSsh().getNodes().isEmpty() ? null
                : new SshConnectionManager(URI.create(properties.getToolPublication().getServiceBaseUrl())), clock);
    }

    SshWorkspaceService(ManagedAgentProperties properties, SshWorkspaceStore store,
            SshConnectionManager connections) {
        this(properties, store, connections, Clock.systemUTC());
    }

    SshWorkspaceService(ManagedAgentProperties properties, SshWorkspaceStore store,
            SshConnectionManager connections, Clock clock) {
        this.properties = properties;
        this.store = store;
        this.connections = connections;
        this.clock = clock;
        Map<String, SshRuntimeSettings.Node> catalog = new LinkedHashMap<>();
        for (var node : properties.getRuntimeBroker().getSsh().getNodes()) {
            if (catalog.putIfAbsent(node.nodeId(), node) != null) {
                throw new IllegalArgumentException("SSH node IDs must be unique");
            }
        }
        this.nodes = Map.copyOf(catalog);
    }

    public record NodeSummary(String nodeId, String displayName) {
    }

    public record NodePage(boolean supported, List<NodeSummary> data) {
    }

    public record Directory(String nodeId, String canonicalPath, String platform) {
    }

    public NodePage list(String tenant, String actor) {
        boolean enabled = properties.getRuntimeBroker().getSsh().isEnabled();
        return new NodePage(enabled, enabled ? nodes.values().stream().filter(node -> node.admits(tenant, actor))
                .map(node -> new NodeSummary(node.nodeId(), node.displayName())).toList() : List.of());
    }

    public Directory check(String tenant, String actor, String nodeId, String path) {
        var node = admit(tenant, actor, nodeId);
        Map<String, Object> result = probe(node, path, ".");
        return new Directory(nodeId, SshWorkspaceStore.string(SshWorkspaceStore.object(result, "identity"), "root"),
                SshWorkspaceStore.string(result, "platform"));
    }

    public Operation create(String tenant, String actor, String node, String path, String name, String key) {
        Operation operation = store.replay(tenant, actor, key, node, path, name);
        if (operation == null) {
            admit(tenant, actor, node);
            operation = store.begin(tenant, actor, key, node, path, name);
        }
        schedule(tenant, actor, operation);
        return operation;
    }

    public Operation get(String tenant, String actor, String id) {
        Operation operation = store.get(tenant, actor, id);
        schedule(tenant, actor, operation);
        return operation;
    }

    public boolean configured() {
        return !nodes.isEmpty();
    }

    public SshConnectionManager connections() {
        if (connections == null) {
            throw unavailable();
        }
        return connections;
    }

    public SshRuntimeNode node(String id) {
        return configuredNode(id).runtimeNode();
    }

    public SshRuntimeStorage runtimeStorage(RuntimeScope scope) {
        return store.runtimeStorage(scope);
    }

    public SshRuntimeStorage runtimeStorage(ContextBinding binding) {
        return store.runtimeStorage(binding.getTenantId(), binding.getStorageId());
    }

    public void verify(ContextBinding binding) {
        verifyBinding(binding);
        var storage = runtimeStorage(binding);
        var result = probe(configuredNode(storage.nodeId()), storage.mountRoot(), binding.getCwdRelative());
        if (!storage.registration().get("identity").equals(result.get("identity"))
                || !storage.registration().get("marker").equals(result.get("marker"))) {
            throw unavailable();
        }
    }

    public void verifyBinding(ContextBinding binding) {
        if (!store.verify(binding)) {
            throw unavailable();
        }
        configuredNode(runtimeStorage(binding).nodeId());
    }

    private SshRuntimeSettings.Node admit(String tenant, String actor, String id) {
        if (!properties.getRuntimeBroker().getSsh().isEnabled()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "ssh_runtime_disabled", "SSH Workspace registration is disabled.");
        }
        SshRuntimeSettings.Node node = nodes.get(id);
        if (node == null || !node.admits(tenant, actor)) {
            throw new ApiException(HttpStatus.FORBIDDEN, "runtime_node_forbidden", "Runtime node is unavailable.");
        }
        return node;
    }

    private SshRuntimeSettings.Node configuredNode(String id) {
        var node = nodes.get(id);
        if (node == null) {
            throw unavailable();
        }
        return node;
    }

    private Map<String, Object> probe(SshRuntimeSettings.Node node, String root, String cwd) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("SSH probe cannot run in a database transaction");
        }
        var request = request(node, "probe");
        request.put("root", root);
        request.put("cwdRelative", cwd);
        request.put("allowedRoots", node.allowedRoots());
        var result = connections().bootstrap(node.runtimeNode(), request);
        if (!node.qwenVersion().equals(result.get("qwenVersion"))) {
            throw new ApiException(HttpStatus.CONFLICT, "ssh_runtime_version_mismatch", "Remote qwen-code version does not match its pinned version.");
        }
        if (SshWorkspaceStore.string(SshWorkspaceStore.object(result, "identity"), "root").length() > 512) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_request", "Canonical Workspace path exceeds its limit.");
        }
        return result;
    }

    private void schedule(String tenant, String actor, Operation operation) {
        if (!List.of("pending", "running").contains(operation.status()) || !running.add(operation.operationId())) {
            return;
        }
        try {
            executor.execute(() -> {
                try {
                    register(tenant, actor, operation.operationId());
                } finally {
                    running.remove(operation.operationId());
                }
            });
        } catch (RejectedExecutionException full) {
            running.remove(operation.operationId());
        }
    }

    private void register(String tenant, String actor, String id) {
        String owner = UUID.randomUUID().toString();
        Intent intent = store.claim(tenant, actor, id, owner);
        if (intent == null) {
            return;
        }
        try {
            var node = configuredNode(intent.nodeId());
            if (!node.admits(tenant, actor)) {
                throw unavailable();
            }
            var result = probe(node, intent.path(), ".");
            Map<String, Object> identity = SshWorkspaceStore.object(result, "identity");
            Map<String, Object> marker = new LinkedHashMap<>(identity);
            marker.put("version", 2);
            marker.put("tenantId", tenant);
            marker.put("storageId", intent.storageId());
            marker.put("registrationId", intent.registrationId());
            Map<String, Object> registration = Map.of("nodeId", intent.nodeId(), "identity", identity, "marker", marker,
                    "qwenVersion", node.qwenVersion());
            if ((!intent.registration().isEmpty() && !intent.registration().equals(registration))
                    || (result.get("marker") != null && !marker.equals(result.get("marker")))) {
                throw unavailable();
            }
            store.reserve(intent, owner, registration);
            var request = request(node, "register-storage");
            request.put("identity", identity);
            request.put("marker", marker);
            request.put("allowedRoots", node.allowedRoots());
            var confirmed = connections().bootstrap(node.runtimeNode(), request);
            if (!identity.equals(confirmed.get("identity")) || !marker.equals(confirmed.get("marker"))) {
                throw unavailable();
            }
            var finalProbe = probe(node, SshWorkspaceStore.string(identity, "root"), ".");
            if (!identity.equals(finalProbe.get("identity")) || !marker.equals(finalProbe.get("marker"))) {
                throw unavailable();
            }
            store.complete(intent, owner);
        } catch (RuntimeBrokerException error) {
            store.fail(intent, owner, error.getCode(), error.isRetryable());
        } catch (ApiException error) {
            store.fail(intent, owner, error.getCode(), false);
        } catch (RuntimeException error) {
            store.fail(intent, owner, "workspace_registration_failed", false);
        }
    }

    @Override
    public String kind() {
        return SshWorkspaceStore.OPERATION;
    }

    @Override
    public List<ParkedOperation> parked(int limit) {
        return store.findParked(limit);
    }

    @Override
    public Optional<AcceptanceVerdict> read(ParkedOperation parked) {
        return store.parked(parked.tenantId(), parked.operationId()).map(this::acceptance);
    }

    /**
     * Committed when the reserved directory still stands at its root and
     * holds this registration's marker. Not committed when it was never
     * reserved (so never sent), when the root now holds another directory,
     * or when it holds no marker: the registration parked one delay after
     * its last attempt, so a register-storage still running then has ended.
     * A node that cannot be read, that no longer admits the actor, or whose
     * directory holds another registration's marker proves nothing.
     */
    private AcceptanceVerdict acceptance(Parked parked) {
        if (!parked.reserved()) {
            return AcceptanceVerdict.notCommitted(parked.failureCode());
        }
        Intent intent = parked.intent();
        SshRuntimeSettings.Node node = nodes.get(intent.nodeId());
        if (node == null || !node.admits(intent.tenantId(), intent.actorId())) {
            return AcceptanceVerdict.unknown();
        }
        Map<String, Object> identity = SshWorkspaceStore.object(intent.registration(), "identity");
        Map<String, Object> marker = SshWorkspaceStore.object(intent.registration(), "marker");
        Map<String, Object> probed = probe(node, SshWorkspaceStore.string(identity, "root"), ".");
        if (!identity.equals(probed.get("identity"))) {
            return AcceptanceVerdict.notCommitted("ssh_runtime_identity_mismatch");
        }
        if (marker.equals(probed.get("marker"))) {
            return AcceptanceVerdict.committed();
        }
        return probed.get("marker") == null ? AcceptanceVerdict.notCommitted(parked.failureCode())
                : AcceptanceVerdict.unknown();
    }

    @Override
    public boolean settle(AgentStateStore ignored, ParkedOperation parked, AcceptanceVerdict verdict, long retryAt) {
        return switch (verdict.acceptance()) {
            case COMMITTED -> store.completeParked(parked.tenantId(), parked.operationId());
            case NOT_COMMITTED -> store.releaseParked(parked.tenantId(), parked.operationId(), verdict.failureCode());
            case UNKNOWN -> store.reparkParked(parked.tenantId(), parked.operationId(), retryAt - clock.millis());
        };
    }

    private static Map<String, Object> request(SshRuntimeSettings.Node node, String operation) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("protocolVersion", 1);
        result.put("operation", operation);
        result.put("nodeId", node.nodeId());
        result.put("stateDirectory", node.stateDirectory());
        return result;
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "ssh_runtime_identity_mismatch", "Original SSH Workspace identity is unavailable.", false);
    }

    @Override
    @PreDestroy
    public void close() {
        executor.shutdownNow();
        if (connections != null) {
            connections.close();
        }
    }
}
