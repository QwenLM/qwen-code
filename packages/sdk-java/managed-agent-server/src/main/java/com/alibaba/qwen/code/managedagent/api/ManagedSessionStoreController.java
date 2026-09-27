package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.BlockRecoveryRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitReceipt;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.RenewWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.RecoveryStateReceipt;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.RestoreHead;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealReceipt;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.TransactionPage;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.WriterGrant;
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

@RestController
@ConditionalOnProperty(prefix = "qwen.managed-agent.session-store",
        name = "enabled", havingValue = "true")
@RequestMapping("/internal/managed-session-store/v1/sessions/{sessionId}")
public class ManagedSessionStoreController {
    private final ManagedSessionStore store;

    public ManagedSessionStoreController(ManagedSessionStore store) {
        this.store = store;
    }

    @PostMapping("/writers:acquire")
    public WriterGrant acquire(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @Valid @RequestBody AcquireWriterRequest request) {
        return store.acquireWriter(tenant.tenantId(), sessionId,
                writerToken, request);
    }

    @PostMapping("/writers:renew")
    public WriterGrant renew(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @Valid @RequestBody RenewWriterRequest request) {
        return store.renewWriter(tenant.tenantId(), sessionId,
                writerToken, request);
    }

    @PostMapping("/writers:seal")
    public SealReceipt seal(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @Valid @RequestBody SealWriterRequest request) {
        return store.sealWriter(tenant.tenantId(), sessionId,
                writerToken, request);
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

    @PostMapping("/transactions:commit")
    public CommitReceipt commit(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @Valid @RequestBody CommitTransactionRequest request) {
        return store.commit(tenant.tenantId(), sessionId,
                writerToken, request);
    }

    @GetMapping("/restore")
    public RestoreHead restore(TenantContext tenant,
            @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @RequestParam String workspaceId) {
        return store.restore(tenant.tenantId(), workspaceId, sessionId,
                writerToken);
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

    @GetMapping(value = "/resources/{resourceId}",
            produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<byte[]> resource(TenantContext tenant,
            @PathVariable String sessionId,
            @PathVariable String resourceId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER)
                    String writerToken,
            @RequestParam String workspaceId) {
        StoredResource resource = store.readResource(tenant.tenantId(),
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
