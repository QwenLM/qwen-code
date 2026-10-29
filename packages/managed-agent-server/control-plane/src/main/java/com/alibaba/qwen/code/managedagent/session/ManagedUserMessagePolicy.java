package com.alibaba.qwen.code.managedagent.session;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.session.UserMessagePolicy;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
@Service("managedUserMessagePolicy")
public class ManagedUserMessagePolicy implements UserMessagePolicy {
    private final AgentStateStore store;
    private final RequestDigests digests;
    private final HarnessConnector harness;
    private final ManagedWorkspaceRegistry workspaces;

    public ManagedUserMessagePolicy(AgentStateStore store, RequestDigests digests,
            HarnessConnector harness, ManagedWorkspaceRegistry workspaces) {
        this.store = store;
        this.digests = digests;
        this.harness = harness;
        this.workspaces = workspaces;
    }

    private static final Set<String> INPUT_TYPES = Set.of("input_text",
            "text");

    private static final int MAX_AGGREGATE_INPUT_CHARS = 4 * 1000 * 1000;

    private static final int MAX_BLOCK_INPUT_CHARS = 1000 * 1000;

    static boolean ready(SessionWorktreeStore.Descriptor worktree) {
        return worktree == null || "ready".equals(worktree.state());
    }

    void requireSubmitterRole(SessionRecord session,
            String actorId) {
        if (session.workspace() != null
                && !workspaces.accessOf(session.tenantId(), actorId,
                        session.workspace().getWorkspaceId())
                        .atLeast(WorkspaceAccess.OPERATOR)) {
            requireLegacyWorkspace(session, actorId);
        }
    }

    void requireSubmitterFacts(SessionRecord session,
            String actorId) {
        if (session.publicChildAgentsVersion() == 1 && store.findChildLineage(session.tenantId(), session.sessionId()) != null) {
            throw new ManagedAgentException(409, "unsupported_feature", "Public child Sessions accept only their delegated input");
        }
        if (session.workspace() != null
                && !maySubmitWorkspaceTurn(session, actorId)) {
            requireLegacyWorkspace(session, actorId);
        }
    }

    boolean maySubmitWorkspaceTurn(SessionRecord session,
            String actorId) {
        if (!maySubmitShape(session, null) || actorId == null
                || actorId.isEmpty()) {
            return false;
        }
        // findReadable throws on an actor id the registry key cannot
        // encode; that caller is simply not a submitter.
        ManagedWorkspaceRegistry.WorkspaceSummary summary;
        try {
            summary = workspaces.findReadable(session.tenantId(), actorId,
                    session.workspace().getWorkspaceId());
        } catch (IllegalArgumentException error) {
            return false;
        }
        // The caller's role and registry state, and on top of them the
        // creator-keyed facts the execution authority re-verifies: the
        // Registry still backs the binding exactly and stays ACTIVE, and
        // the create-command actor keeps OPERATOR or above — after a
        // demotion or re-registration admission refuses first instead of
        // accepting a Turn that can only fail.
        return summary != null && summary.canCreateSession()
                && store.hasExecutionRegistryFacts(session.tenantId(),
                        session.sessionId());
    }

    boolean maySubmitWorkspaceTurn(SessionRecord session,
            Map<String, ManagedWorkspaceRegistry.ReadableGrant> grants,
            java.util.Set<String> executable, SessionWorktreeStore.Descriptor worktree) {
        if (!maySubmitShape(session, worktree)) {
            return false;
        }
        var grant = grants.get(session.workspace().getWorkspaceId());
        return grant != null && grant.canCreateSession()
                && executable.contains(session.sessionId());
    }

    boolean maySubmitShape(SessionRecord session, SessionWorktreeStore.Descriptor worktree) {
        if (session.workspace() == null
                || !harness.isWorkspaceFilesAvailable()) {
            return false;
        }
        // The authority execution cites (WorkspaceExecutionStore
        // .authorizePassiveAttachment) fixes these at creation: a Session
        // that fails them can never execute, so admission must not certify
        // it. Empty bound creation skips that validation by design.
        return "ACTIVE".equals(session.status()) && session.deletedAt() == null
                && ready(worktree)
                && ("qwen-code".equals(session.agentId())
                        || session.agentDefinitionDigest() != null)
                && WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(
                        session.workspace().getContextConfigRef());
    }

    void requireLegacyWorkspace(String tenantId, String actorId,
            String sessionId) {
        requireLegacyWorkspace(store.requireSession(tenantId, sessionId),
                actorId);
    }

    void requireLegacyWorkspace(SessionRecord session,
            String actorId) {
        if (session.workspace() != null) {
            // A tombstone is invisible to every actor shape, as the reads
            // answer: the fence stands above the role split, whose 403/409
            // codes are live-Session answers. An unbound tombstone needs no
            // fence here — its 404 stands below the replay in
            // beginSessionMutation, and a recorded lifecycle outcome must
            // keep answering above it.
            if ("DELETED".equals(session.status())) {
                throw new ManagedAgentException(404,
                        "session_not_found", "The Session was not found.");
            }
            String workspaceId = session.workspace().getWorkspaceId();
            WorkspaceAccess access = workspaces.accessOf(session.tenantId(),
                    actorId, workspaceId);
            if (!access.canRead()) {
                throw new ManagedAgentException(404,
                        "session_not_found", "The Session was not found.");
            }
            if (access.atLeast(WorkspaceAccess.OPERATOR)) {
                throw new ManagedAgentException(409,
                        "workspace_unavailable",
                        "Hosted Workspace execution is not available.");
            }
            throw new ManagedAgentException(403,
                    "session_operation_forbidden",
                    "Only a Workspace operator may use the Session.");
        }
    }

    SessionRecord requireVisibleSession(String tenantId,
            String sessionId) {
        return requireVisibleSession(store.requireSession(tenantId,
                sessionId));
    }

    SessionRecord requireVisibleSession(SessionRecord session) {
        if ("DELETED".equals(session.status())) {
            throw new ManagedAgentException(404,
                    "session_not_found", "The Session was not found.");
        }
        return session;
    }

    public boolean supportsUserMessageQueue() { return harness.supportsUserMessageQueue(); }

    public SessionRecord authorizeUserMessageActor(String tenantId, String actorId, String sessionId) {
        if (actorId == null || actorId.isBlank()) {
            throw new ManagedAgentException(401, "actor_required", "An authenticated actor is required.");
        }
        SessionRecord session = store.requireSession(tenantId, sessionId);
        requireSubmitterRole(session, actorId);
        return session;
    }

    public SessionRecord authorizeUserMessages(String tenantId, String actorId, String sessionId) {
        SessionRecord session = authorizeUserMessageActor(tenantId, actorId, sessionId);
        requireVisibleSession(session);
        requireSubmitterFacts(session, actorId);
        if (!"ACTIVE".equals(session.status())) {
            throw new ManagedAgentException(409, "session_not_active", "The Session does not accept messages.");
        }
        return session;
    }

    public List<Map<String, Object>> userMessageInput(List<InputBlock> blocks) {
        List<Map<String, Object>> normalized = input(blocks, true);
        if (normalized.stream().anyMatch(block -> "image".equals(block.get("type")))) {
            throw new ManagedAgentException(400, "unsupported_input", "Images require an idle Turn.");
        }
        return normalized;
    }

    List<Map<String, Object>> input(List<InputBlock> blocks,
            boolean required) {
        if (blocks == null || blocks.isEmpty()) {
            if (required) {
                throw new ManagedAgentException(400,
                        "input_required", "At least one input is required.");
            }
            return List.of();
        }
        List<Map<String, Object>> result = new ArrayList<>();
        long totalChars = 0;
        for (InputBlock block : blocks) {
            if (block != null && !INPUT_TYPES.contains(block.type())) {
                result.add(ManagedInputAttachments.normalize(block));
                continue;
            }
            if (block == null || block.text() == null || block.text().isEmpty()
                    || block.mimeType() != null || block.name() != null || block.data() != null) {
                throw new ManagedAgentException(400,
                        "unsupported_input",
                        "Expected non-empty text, a text file or an image.");
            }
            // Code points, matching the published schema's maxLength; a
            // String.length() count would disagree on astral-plane text.
            int blockChars = block.text().codePointCount(0,
                    block.text().length());
            if (blockChars > MAX_BLOCK_INPUT_CHARS) {
                throw new ManagedAgentException(400,
                        "invalid_input",
                        "Input block exceeds the " + MAX_BLOCK_INPUT_CHARS
                                + " character per-block limit.");
            }
            totalChars += blockChars;
            if (totalChars > MAX_AGGREGATE_INPUT_CHARS) {
                throw new ManagedAgentException(400,
                        "invalid_input",
                        "Input exceeds the " + MAX_AGGREGATE_INPUT_CHARS
                                + " character aggregate limit.");
            }
            result.add(Map.of("type", "text", "text",
                    replaceLoneSurrogates(block.text())));
        }
        var normalized = normalizeInput(result);
        if (normalized.stream().anyMatch(block -> !"text".equals(block.get("type")))
                && digests.byteLength(normalized) > ManagedInputAttachments.MAX_INPUT_BYTES) {
            throw new ManagedAgentException(413, "input_too_large",
                    "An input containing attachments must fit within 8 MiB of encoded JSON.");
        }
        return normalized;
    }

    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> normalizeInput(
            List<Map<String, Object>> input) {
        List<Map<String, Object>> result = new ArrayList<>(input.size());
        for (Map<String, Object> block : input) {
            result.add((Map<String, Object>) normalizeValue(block));
        }
        return List.copyOf(result);
    }

    static Object normalizeValue(Object value) {
        if (value instanceof String text) {
            return replaceLoneSurrogates(text);
        }
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> copy = new LinkedHashMap<>(map.size());
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                copy.put(replaceLoneSurrogates((String) entry.getKey()),
                        normalizeValue(entry.getValue()));
            }
            return copy;
        }
        if (value instanceof List<?> list) {
            List<Object> copy = new ArrayList<>(list.size());
            for (Object item : list) {
                copy.add(normalizeValue(item));
            }
            return Collections.unmodifiableList(copy);
        }
        return value;
    }

    static String replaceLoneSurrogates(String text) {
        StringBuilder out = null;
        int written = 0;
        for (int i = 0; i < text.length(); i++) {
            char current = text.charAt(i);
            if (Character.isHighSurrogate(current)) {
                if (i + 1 < text.length()
                        && Character.isLowSurrogate(text.charAt(i + 1))) {
                    i++; // a well-formed pair passes through unchanged
                    continue;
                }
            } else if (!Character.isLowSurrogate(current)) {
                continue;
            }
            if (out == null) {
                out = new StringBuilder(text.length());
            }
            out.append(text, written, i).append('�');
            written = i + 1;
        }
        if (out == null) {
            return text;
        }
        out.append(text, written, text.length());
        return out.toString();
    }
}
