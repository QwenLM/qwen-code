package com.alibaba.qwen.code.managedagent.store;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;

public final class ManagedSessionStoreModels {
    public static final String WRITER_TOKEN_HEADER =
            "X-Qwen-Managed-Writer-Token";
    public static final int MAX_INLINE_RESOURCE_BYTES = 64 * 1024;
    public static final int MAX_TRANSACTION_BYTES = 8 * 1024 * 1024;
    public static final int MAX_TRANSACTION_EVENTS = 256;
    public static final long MAX_SAFE_COUNTER = 9_007_199_254_740_990L;
    private static final String DIGEST_PATTERN = "^[0-9a-f]{64}$";

    private ManagedSessionStoreModels() {
    }

    public record AcquireWriterRequest(
            @NotBlank @Size(max = 512) String workspaceId,
            @NotBlank @Size(max = 512) String writerId,
            @NotNull @Min(1_000) @Max(300_000) Long leaseMillis) {
    }

    public record RenewWriterRequest(
            @NotBlank @Size(max = 512) String workspaceId,
            @NotBlank @Size(max = 512) String writerId,
            @Min(1) @Max(MAX_SAFE_COUNTER) long writerGeneration,
            @NotNull @Min(1_000) @Max(300_000) Long leaseMillis) {
    }

    public record SealWriterRequest(
            @NotBlank @Size(max = 512) String workspaceId,
            @NotBlank @Size(max = 512) String writerId,
            @Min(1) @Max(MAX_SAFE_COUNTER) long writerGeneration) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WriterGrant(long writerGeneration, long leaseUntil,
            long journalRevision, long committedSequence,
            String lastCommitDigest, long activationEpoch,
            boolean replayed) {
    }

    public record SealReceipt(long writerGeneration, String state,
            boolean replayed) {
    }

    public record CommitResource(
            @NotBlank @Size(max = 512) String resourceId,
            @NotBlank @Size(max = 512) String kind,
            @Min(1) int schemaVersion,
            @Min(0) long byteLength,
            @NotBlank @Pattern(regexp = DIGEST_PATTERN) String digest,
            @Size(max = 90_000) String bytesBase64) {
    }

    public record CommitTransactionRequest(
            @NotBlank @Size(max = 512) String workspaceId,
            @NotBlank @Size(max = 512) String writerId,
            @Min(1) @Max(MAX_SAFE_COUNTER) long writerGeneration,
            @Min(0) @Max(MAX_SAFE_COUNTER) long expectedJournalRevision,
            @Min(0) @Max(MAX_SAFE_COUNTER) long expectedCommittedSequence,
            @NotBlank @Size(max = 512) String transactionId,
            @NotBlank @Size(max = 4096) String operation,
            @NotBlank @Size(max = 512) String commandId,
            @NotBlank @Pattern(regexp = DIGEST_PATTERN)
                    String contentDigest,
            @Min(0) @Max(MAX_SAFE_COUNTER) long firstSequence,
            @Min(0) @Max(MAX_SAFE_COUNTER) long lastSequence,
            @Min(0) @Max(MAX_TRANSACTION_EVENTS) int eventCount,
            @Pattern(regexp = DIGEST_PATTERN) String eventsDigest,
            @Pattern(regexp = DIGEST_PATTERN) String previousCommitDigest,
            @Pattern(regexp = DIGEST_PATTERN) String commitDigest,
            @Min(0) @Max(MAX_SAFE_COUNTER) long activationEpoch,
            @Size(max = 512) String latestCheckpointResourceId,
            @Min(1) @Max(MAX_TRANSACTION_EVENTS + 1) int recordCount,
            @NotBlank @Size(max = 11_184_820) String recordBytesBase64,
            @NotBlank @Pattern(regexp = DIGEST_PATTERN)
                    String recordDigest,
            @Size(max = 1024) List<@Valid CommitResource> resources) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CommitReceipt(long journalRevision,
            String transactionId, String commandId, String operation,
            long firstSequence, long lastSequence,
            long committedSequence, String commitDigest,
            boolean replayed) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RestoreHead(String state, int storageVersion,
            long writerGeneration, long journalRevision,
            long committedSequence, String lastCommitDigest,
            long activationEpoch, String latestCheckpointResourceId,
            long compactedThroughRevision, String recoveryStatus,
            String recoveryDetailCode) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record StoredTransaction(long journalRevision,
            String transactionId, String operation, String commandId,
            String contentDigest, long firstSequence, long lastSequence,
            int eventCount, String eventsDigest,
            String previousCommitDigest, String commitDigest,
            long writerGeneration, long activationEpoch,
            String latestCheckpointResourceId,
            String recordEncoding, String recordBytesBase64,
            long byteLength, String recordDigest) {
    }

    public record TransactionPage(List<StoredTransaction> transactions,
            long nextRevision, boolean hasMore) {
    }

    public record StoredResource(String resourceId, String kind,
            int schemaVersion, long byteLength, String digest,
            byte[] bytes) {
    }
}
