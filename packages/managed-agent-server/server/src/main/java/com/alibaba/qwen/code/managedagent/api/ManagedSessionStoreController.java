package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.BlockRecoveryRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitReceipt;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.PublishToolResultRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.RecoveryStateReceipt;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.RenewWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.RestoreHead;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.SealReceipt;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.ToolResultResourceRef;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.TransactionPage;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.WriterGrant;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.ManagedNativeJournalSnapshots;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedUserMessageStore;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonUnwrapped;
import jakarta.validation.Valid;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@org.springframework.beans.factory.annotation.Qualifier("managedAgentTransactionManager")
@RestController
@ConditionalOnProperty(prefix = "qwen.managed-agent.session-store",
        name = "enabled", havingValue = "true")
@RequestMapping("/internal/managed-session-store/v1/sessions/{sessionId}")
public class ManagedSessionStoreController {
    private final ManagedSessionStore store;
    private final ManagedUserMessageStore userMessages;
    private final ManagedNativeJournalSnapshots snapshots;

    public ManagedSessionStoreController(ManagedSessionStore store, ManagedUserMessageStore userMessages,
            ManagedNativeJournalSnapshots snapshots) {
        this.store = store;
        this.userMessages = userMessages;
        this.snapshots = snapshots;
    }

    public record QueueClaim(String workspaceId, String writerId, long writerGeneration, String promptId, boolean initialOnly) { }

    @PostMapping("/user-messages:claim")
    @org.springframework.transaction.annotation.Transactional
    public Object claimUserMessages(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @RequestBody QueueClaim request) {
        store.authorizeOrdinary(tenant.tenantId(), sessionId, writerToken,
                new ManagedSessionStoreModels.AuthorizeLifecycleRequest(request.workspaceId(), request.writerId(), request.writerGeneration(), null));
        return userMessages.claim(tenant.tenantId(), sessionId, request.promptId(), request.initialOnly());
    }

    @PostMapping("/approval:query")
    public Object approvalSelection(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @Valid @RequestBody ManagedSessionStoreModels.AuthorizeLifecycleRequest request) {
        var selected = store.approvalSelection(tenant.tenantId(), sessionId, writerToken, request);
        return selected == null ? com.fasterxml.jackson.databind.node.NullNode.getInstance() : selected;
    }

    static com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority lifecycleAuthority(HttpHeaders headers) {
        String operation = headers.getFirst(com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority.OPERATION_HEADER);
        String generation = headers.getFirst(com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority.GENERATION_HEADER);
        if (operation == null && generation == null) {
            return null;
        }
        try {
            return new com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority(operation, Long.parseLong(generation));
        } catch (RuntimeException error) {
            throw new ManagedAgentException(400, "invalid_lifecycle_authority", "Invalid lifecycle authority.");
        }
    }

    @PostMapping("/execution:authorize")
    public java.util.Map<String, Object> authorizeOrdinary(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @Valid @RequestBody ManagedSessionStoreModels.AuthorizeLifecycleRequest request) {
        store.authorizeOrdinary(tenant.tenantId(), sessionId, writerToken, request);
        return java.util.Map.of("authorized", true);
    }

    @PostMapping("/lifecycle:authorize")
    public java.util.Map<String, Object> authorizeLifecycle(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @Valid @RequestBody ManagedSessionStoreModels.AuthorizeLifecycleRequest request,
            @RequestHeader HttpHeaders headers) {
        store.authorizeLifecycle(tenant.tenantId(), sessionId, writerToken, request, lifecycleAuthority(headers));
        return java.util.Map.of("authorized", true);
    }

    @PostMapping("/writers:acquire")
    public WriterGrant acquire(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @Valid @RequestBody AcquireWriterRequest request,
            @RequestHeader HttpHeaders headers) {
        return store.acquireWriter(tenant.tenantId(), sessionId,
                writerToken, request, lifecycleAuthority(headers));
    }

    @PostMapping("/writers:renew")
    public WriterGrant renew(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @Valid @RequestBody RenewWriterRequest request,
            @RequestHeader HttpHeaders headers) {
        return store.renewWriter(tenant.tenantId(), sessionId,
                writerToken, request, lifecycleAuthority(headers));
    }

    @PostMapping("/writers:seal")
    public SealReceipt seal(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @Valid @RequestBody SealWriterRequest request,
            @RequestHeader HttpHeaders headers) {
        return store.sealWriter(tenant.tenantId(), sessionId,
                writerToken, request, lifecycleAuthority(headers));
    }

    @PostMapping("/writers:release-ownership")
    public com.fasterxml.jackson.databind.JsonNode releaseOwnership(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @Valid @RequestBody ManagedSessionStoreModels.ReleaseOwnershipRequest request) {
        return store.releaseOwnership(tenant.tenantId(), sessionId, writerToken, request);
    }

    @PostMapping("/writers:quiesce-ownership")
    public java.util.Map<String, String> quiesceOwnership(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @Valid @RequestBody ManagedSessionStoreModels.QuiesceOwnershipRequest request) {
        store.quiesceOwnership(tenant.tenantId(), sessionId, writerToken, request);
        return java.util.Map.of("state", "QUIESCING");
    }

    @PostMapping("/recovery:block")
    public RecoveryStateReceipt blockRecovery(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @Valid @RequestBody BlockRecoveryRequest request) {
        return store.blockRecovery(tenant.tenantId(), sessionId,
                writerToken, request);
    }

    @PostMapping({"/transactions:commit", "/transactions:commit-v2"})
    public CommitReceipt commit(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @Valid @RequestBody CommitTransactionRequest request,
            @RequestHeader HttpHeaders headers) {
        return store.commit(tenant.tenantId(), sessionId,
                writerToken, request, lifecycleAuthority(headers));
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RestoreResponse(@JsonUnwrapped RestoreHead head,
            ManagedNativeJournalSnapshots.Descriptor nativeSnapshot) { }

    @GetMapping("/restore")
    public RestoreResponse restore(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @RequestParam String workspaceId,
            @RequestParam(defaultValue = "false") boolean includeNativeSnapshot) {
        RestoreHead head = store.restore(tenant.tenantId(), workspaceId, sessionId, writerToken);
        return new RestoreResponse(head, includeNativeSnapshot
                ? snapshots.select(tenant.tenantId(), workspaceId, sessionId, writerToken, head) : null);
    }

    @PostMapping("/tool-results:publish")
    public ToolResultResourceRef publishToolResult(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @Valid @RequestBody PublishToolResultRequest request, @RequestHeader HttpHeaders headers) {
        return store.publishToolResult(tenant.tenantId(), sessionId, writerToken, request, lifecycleAuthority(headers));
    }

    @GetMapping("/transactions")
    public TransactionPage transactions(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @RequestParam String workspaceId,
            @RequestParam(defaultValue = "0") long afterRevision,
            @RequestParam(defaultValue = "100") int limit) {
        return store.transactions(tenant.tenantId(), workspaceId,
                sessionId, writerToken, afterRevision, limit);
    }

    @GetMapping("/transactions:recent")
    public ManagedSessionStoreModels.RecentTransactionPage recentTransactions(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @RequestParam String workspaceId,
            @RequestParam(required = false) Long throughRevision,
            @RequestParam(required = false) Long beforeRevision,
            @RequestParam(defaultValue = "100") int limit) {
        return store.recentTransactions(tenant.tenantId(), workspaceId, sessionId, writerToken,
                throughRevision, beforeRevision, limit);
    }

    @GetMapping("/transactions:lookup")
    public ManagedSessionStoreModels.CommandTransaction commandTransaction(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @RequestParam String workspaceId,
            @RequestParam String operation, @RequestParam String commandId,
            @RequestParam(required = false) Long throughRevision) {
        return store.commandTransaction(tenant.tenantId(), workspaceId, sessionId, writerToken,
                throughRevision, operation, commandId);
    }

    @PostMapping("/journal-snapshots:publish")
    public ManagedNativeJournalSnapshots.Descriptor publishSnapshot(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @Valid @RequestBody ManagedNativeJournalSnapshots.PublishRequest request) {
        return snapshots.publish(tenant.tenantId(), sessionId, writerToken, request);
    }

    @GetMapping("/journal-snapshots/{snapshotId}")
    public ManagedNativeJournalSnapshots.Descriptor snapshot(TenantContext tenant,
            @PathVariable String sessionId, @PathVariable String snapshotId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @RequestParam String workspaceId) {
        return snapshots.read(tenant.tenantId(), workspaceId, sessionId, writerToken, snapshotId);
    }

    @GetMapping("/journal-snapshots/{snapshotId}/pages")
    public ManagedNativeJournalSnapshots.PageResult snapshotPages(TenantContext tenant,
            @PathVariable String sessionId, @PathVariable String snapshotId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @RequestParam String workspaceId, @RequestParam(defaultValue = "0") long afterRevision,
            @RequestParam(defaultValue = "100") int limit) {
        return snapshots.pages(tenant.tenantId(), workspaceId, sessionId, writerToken, snapshotId, afterRevision, limit);
    }

    @GetMapping(value = "/resources/{resourceId}",
            produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<byte[]> resource(TenantContext tenant,
            @PathVariable String sessionId,
            @PathVariable String resourceId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @RequestParam String workspaceId) {
        StoredResource resource = store.readOwnerResource(tenant.tenantId(),
                workspaceId, sessionId, resourceId, writerToken);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_LENGTH,
                        Long.toString(resource.byteLength()))
                .header("X-Qwen-Resource-Kind", resource.kind())
                .header("X-Qwen-Resource-Schema-Version",
                        Integer.toString(resource.schemaVersion()))
                .header("X-Qwen-Resource-Digest", resource.digest())
                .body(resource.bytes());
    }
}
