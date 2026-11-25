package com.alibaba.qwen.code.daemon;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/** Typed public operations on Managed Sessions. */
public final class ManagedSessions {
    private final ManagedAgentClient client;

    ManagedSessions(ManagedAgentClient client) {
        this.client = client;
    }

    /** Admits a Session and returns its current view, including its ID and any initial Turn. */
    public ManagedSession create(ManagedCreateSessionRequest request, String idempotencyKey) {
        return new ManagedSession(client.createSession(request.toJson(), idempotencyKey));
    }

    public ManagedSession get(String sessionId) {
        return new ManagedSession(client.getSession(sessionId));
    }

    public ManagedPage<ManagedSession> list() {
        return list(null, null, null, null);
    }

    /** Pass null for the first cursor, or to omit a filter. */
    public ManagedPage<ManagedSession> list(String cursor, Integer limit, ArchiveFilter archiveFilter, String titleQuery) {
        return new ManagedPage<>(client.listSessions(cursor, limit,
                archiveFilter == null ? null : archiveFilter.wire, titleQuery), ManagedSession::new);
    }

    public ManagedSession rename(String sessionId, String title, String idempotencyKey) {
        return new ManagedSession(client.renameSession(sessionId, title, idempotencyKey));
    }

    public ManagedOperation close(String sessionId, String idempotencyKey) {
        return new ManagedOperation(client.closeSession(sessionId, idempotencyKey));
    }

    public ManagedOperation archive(String sessionId, String idempotencyKey) {
        return new ManagedOperation(client.archiveSession(sessionId, idempotencyKey));
    }

    public ManagedSession unarchive(String sessionId, String idempotencyKey) {
        return new ManagedSession(client.unarchiveSession(sessionId, idempotencyKey));
    }

    public ManagedOperation delete(String sessionId, String idempotencyKey) {
        return new ManagedOperation(client.deleteSession(sessionId, idempotencyKey));
    }

    public ManagedOperation getOperation(String sessionId, String operationId) {
        return new ManagedOperation(client.getSessionOperation(sessionId, operationId));
    }

    /** Submits text and returns its admission receipt. Use the Turn ID to observe execution. */
    public ManagedTurnAdmission submitText(String sessionId, String text, String idempotencyKey) {
        return submit(sessionId, List.of(ManagedInput.text(text)), idempotencyKey);
    }

    /** Submits input blocks and returns their Turn admission receipt. */
    public ManagedTurnAdmission submit(String sessionId, List<ManagedInput> input, String idempotencyKey) {
        return new ManagedTurnAdmission(client.submitTurn(sessionId,
                input.stream().map(ManagedInput::toJson).collect(Collectors.toList()), idempotencyKey));
    }

    public ManagedTurnAdmission cancelTurn(String sessionId, String turnId, String idempotencyKey) {
        return new ManagedTurnAdmission(client.cancelTurn(sessionId, turnId, idempotencyKey));
    }

    public ManagedTurn getTurn(String sessionId, String turnId) {
        return new ManagedTurn(client.getTurn(sessionId, turnId));
    }

    public ManagedPage<ManagedTurn> listTurns(String sessionId, String cursor, Integer limit) {
        return new ManagedPage<>(client.listTurns(sessionId, cursor, limit), ManagedTurn::new);
    }

    public ItemPage listItems(String sessionId, String cursor, Integer limit) {
        return listItems(sessionId, null, cursor, limit);
    }

    public ItemPage listItems(String sessionId, Long after, String cursor, Integer limit) {
        return new ItemPage(client.listItems(sessionId, after, cursor, limit));
    }

    /** Opens an SSE stream from the beginning. The caller must close the stream. */
    public ManagedAgentEventStream streamEvents(String sessionId) {
        return streamEvents(sessionId, 0);
    }

    /** Opens SSE after the last sequence successfully processed by the caller. */
    public ManagedAgentEventStream streamEvents(String sessionId, long after) {
        return client.streamEvents(sessionId, after);
    }

    public ManagedPage<ManagedAgentEventStream.Event> listEvents(String sessionId, Long after, Integer limit) {
        return new ManagedPage<>(client.listEvents(sessionId, after, limit), ManagedAgentEventStream.Event::fromJson);
    }

    public ManagedPage<ManagedAction> listActions(String sessionId, String cursor, Integer limit, Boolean includeChildren) {
        return new ManagedPage<>(client.listActions(sessionId, cursor, limit, includeChildren), ManagedAction::new);
    }

    public ManagedAction getAction(String sessionId, String actionId) {
        return new ManagedAction(client.getAction(sessionId, actionId));
    }

    /** Uses the revision pair from the returned permission action. */
    public ManagedOperation decidePermission(ManagedAction action, String optionId, String idempotencyKey) {
        return respond(action, "permission", "option_id", optionId, idempotencyKey);
    }

    /** Uses the revision pair from the returned question action. */
    public ManagedOperation answerQuestions(ManagedAction action, List<ManagedAction.Answer> answers, String idempotencyKey) {
        return respond(action, "question", "answers", answers.stream().map(ManagedAction.Answer::toJson)
                .collect(Collectors.toList()), idempotencyKey);
    }

    public ManagedRecovery getRecovery(String sessionId) {
        return new ManagedRecovery(client.getRecovery(sessionId));
    }

    public ManagedRecovery recheckRecovery(String sessionId, String turnId) {
        return new ManagedRecovery(client.recheckRecovery(sessionId, turnId));
    }

    public ManagedResources getResources(String sessionId) {
        return new ManagedResources(client.getResources(sessionId));
    }

    public ManagedHookCatalog getHookCatalog(String sessionId) {
        return new ManagedHookCatalog(client.getHookCatalog(sessionId));
    }

    public ManagedMcpCatalog getMcpCatalog(String sessionId) {
        return new ManagedMcpCatalog(client.getMcpCatalog(sessionId));
    }

    private ManagedOperation respond(ManagedAction action, String kind, String field, Object value, String key) {
        if (!kind.equals(action.getKind())) {
            throw new IllegalArgumentException("Expected a " + kind + " action");
        }
        return new ManagedOperation(client.respondToAction(action.getSessionId(), action.getId(), Map.of(
                "kind", kind, "input_revision", action.getInputRevision(),
                "policy_revision", action.getPolicyRevision(), field, value), key));
    }

    public enum ArchiveFilter {
        ALL("all"),
        ARCHIVED("archived"),
        UNARCHIVED("unarchived");

        private final String wire;

        ArchiveFilter(String wire) {
            this.wire = wire;
        }
    }

    /** One page of projected history and the corresponding event snapshot sequence. */
    public static final class ItemPage extends ManagedPage<ManagedItem> {
        private ItemPage(Map<String, Object> json) {
            super(json, ManagedItem::new);
        }

        public long getSnapshotThroughSequence() {
            return number("snapshot_through_sequence");
        }
    }
}
