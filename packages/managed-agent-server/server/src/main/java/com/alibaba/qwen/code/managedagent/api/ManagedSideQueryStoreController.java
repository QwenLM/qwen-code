package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.TransactionPage;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.Claim;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.FrozenInput;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.InputPublication;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.Query;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.ResultUpdate;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.repository.ManagedSideQueries;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@ConditionalOnProperty(prefix = "qwen.managed-agent.session-store", name = "enabled", havingValue = "true")
@RequestMapping("/internal/managed-session-store/v1/sessions/{sessionId}/side-queries/{queryId}")
public class ManagedSideQueryStoreController {
    private final ManagedSideQueries queries;

    public ManagedSideQueryStoreController(ManagedSideQueries queries) { this.queries = queries; }

    public record Claimed(@NotNull Claim claim) { }
    public record Transactions(@NotNull Claim claim, long afterRevision, int limit) { }
    public record ResourceRead(@NotNull Claim claim, String resourceId) { }
    public record Stage(@NotNull Claim claim, @NotNull CommitResource resource) { }
    public record Publish(@NotNull Claim claim, @NotNull InputPublication publication) { }
    public record Result(@NotNull Claim claim, @NotNull ResultUpdate update) { }

    @PostMapping("/input")
    public FrozenInput input(TenantContext tenant, @PathVariable String sessionId, @PathVariable String queryId,
            @Valid @RequestBody Claimed request) {
        return queries.frozen(tenant.tenantId(), sessionId, queryId, request.claim());
    }

    @PostMapping("/transactions")
    public TransactionPage transactions(TenantContext tenant, @PathVariable String sessionId, @PathVariable String queryId,
            @Valid @RequestBody Transactions request) {
        return queries.transactions(tenant.tenantId(), sessionId, queryId, request.claim(), request.afterRevision(), request.limit());
    }

    @PostMapping("/resources/read")
    public StoredResource resource(TenantContext tenant, @PathVariable String sessionId, @PathVariable String queryId,
            @Valid @RequestBody ResourceRead request) {
        return queries.resource(tenant.tenantId(), sessionId, queryId, request.claim(), request.resourceId());
    }

    @PostMapping("/model-config")
    public Map<String, Object> modelConfig(TenantContext tenant, @PathVariable String sessionId, @PathVariable String queryId,
            @Valid @RequestBody Claimed request) {
        var config = queries.modelConfig(tenant.tenantId(), sessionId, queryId, request.claim());
        return Map.of("digest", config.digest(), "config", config.wireValue());
    }

    @PostMapping("/resources/stage")
    public Map<String, Object> stage(TenantContext tenant, @PathVariable String sessionId, @PathVariable String queryId,
            @Valid @RequestBody Stage request) {
        queries.stage(tenant.tenantId(), sessionId, queryId, request.claim(), request.resource());
        return Map.of("resourceId", request.resource().resourceId());
    }

    @PostMapping("/input-ready")
    public Query publish(TenantContext tenant, @PathVariable String sessionId, @PathVariable String queryId,
            @Valid @RequestBody Publish request) {
        return queries.publishInput(tenant.tenantId(), sessionId, queryId, request.claim(), request.publication());
    }

    @PostMapping("/running")
    public Map<String, Object> running(TenantContext tenant, @PathVariable String sessionId, @PathVariable String queryId,
            @Valid @RequestBody Claimed request) {
        return Map.of("started", queries.start(tenant.tenantId(), sessionId, queryId, request.claim()));
    }

    @PostMapping("/result")
    public Query result(TenantContext tenant, @PathVariable String sessionId, @PathVariable String queryId,
            @Valid @RequestBody Result request) {
        return queries.snapshot(tenant.tenantId(), sessionId, queryId, request.claim(), request.update());
    }

    @PostMapping("/heartbeat")
    public Map<String, Object> heartbeat(TenantContext tenant, @PathVariable String sessionId, @PathVariable String queryId,
            @Valid @RequestBody Claimed request) {
        return Map.of("active", queries.active(tenant.tenantId(), sessionId, queryId, request.claim()));
    }
}
