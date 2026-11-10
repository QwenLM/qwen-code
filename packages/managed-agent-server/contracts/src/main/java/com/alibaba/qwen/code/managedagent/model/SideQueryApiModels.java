package com.alibaba.qwen.code.managedagent.model;

import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;
import java.util.Map;

public final class SideQueryApiModels {
    private SideQueryApiModels() { }

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PublicCreate(@NotBlank String kind, String trigger,
            @Size(max = 4096) String question, String expectedContentVersion,
            Long expectedMainInputBoundary) {
        public ManagedSideQueryModels.Create command(String key) {
            return new ManagedSideQueryModels.Create(kind, trigger, question, key,
                    expectedContentVersion, expectedMainInputBoundary);
        }
    }

    public record WebShellCreate(@NotBlank String sessionId, @NotBlank String kind,
            String trigger, @Size(max = 4096) String question, @NotBlank String idempotencyKey,
            String expectedContentVersion, Long expectedMainInputBoundary, String requestId) {
        public ManagedSideQueryModels.Create command() {
            return new ManagedSideQueryModels.Create(kind, trigger, question, idempotencyKey,
                    expectedContentVersion, expectedMainInputBoundary);
        }
    }

    public record WebShellQuery(@NotBlank String sessionId, @NotBlank String queryId,
            Long afterRevision, String requestId) { }
    public record WebShellList(@NotBlank String sessionId, String cursor, Integer limit, String requestId) { }

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PublicPrefix(long journalRevision, long committedSequence,
            String lastCommitDigest, long completedTurnSequence, String contentVersion,
            long completedUserTurnCount, long mainInputBoundary) {
        static PublicPrefix from(ManagedSideQueryModels.Prefix value) {
            return new PublicPrefix(value.journalRevision(), value.committedSequence(), value.lastCommitDigest(),
                    value.completedTurnSequence(), value.contentVersion(), value.completedUserTurnCount(), value.mainInputBoundary());
        }
    }

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PublicQuery(String queryId, String sessionId, String kind, String trigger,
            String question, String status, String outcome, PublicPrefix source, long resultRevision,
            String text, Map<String, Object> usage, String errorCode, long createdAt, long updatedAt, long deadlineAt) {
        public static PublicQuery from(ManagedSideQueryModels.Query value) {
            return new PublicQuery(value.queryId(), value.sessionId(), value.kind(), value.trigger(), value.question(),
                    value.status(), value.outcome(), PublicPrefix.from(value.source()), value.resultRevision(), value.text(),
                    value.usage(), value.errorCode(), value.createdAt(), value.updatedAt(), value.deadlineAt());
        }
    }

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PublicContext(String actorScopeKey, String contentVersion, long completedUserTurnCount,
            long mainInputBoundary, boolean automaticEligible, boolean generationAvailable, String unavailableReason,
            String latestRecapContentVersion, Long latestRecapUserTurnCount) {
        public static PublicContext from(ManagedSideQueryModels.Context value) {
            return new PublicContext(value.actorScopeKey(), value.contentVersion(), value.completedUserTurnCount(),
                    value.mainInputBoundary(), value.automaticEligible(), value.generationAvailable(), value.unavailableReason(),
                    value.latestRecapContentVersion(), value.latestRecapUserTurnCount());
        }
    }

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PublicPage(List<PublicQuery> items, String nextCursor) {
        public static PublicPage from(ManagedSideQueryModels.Page value) {
            return new PublicPage(value.items().stream().map(PublicQuery::from).toList(), value.nextCursor());
        }
    }
}
