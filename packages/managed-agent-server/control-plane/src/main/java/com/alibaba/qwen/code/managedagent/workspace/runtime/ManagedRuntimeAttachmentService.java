package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

import java.util.Objects;
import java.util.concurrent.CompletionStage;

/** Authorized Java access to the Runtime attachment of one existing Managed Session. */
public class ManagedRuntimeAttachmentService {
    private static final String ORDINARY_TURN = "bootstrap";
    private final ManagedAgentService sessions;
    private final WorkspaceRuntimeResolver workspaces;
    private final RuntimeBrokerOperations broker;
    private final RuntimeSessionRepository runtimeSessions;
    private final RuntimeBindingRepository bindings;

    public ManagedRuntimeAttachmentService(ManagedAgentService sessions, WorkspaceRuntimeResolver workspaces,
            RuntimeBrokerOperations broker, RuntimeSessionRepository runtimeSessions, RuntimeBindingRepository bindings) {
        this.sessions = sessions;
        this.workspaces = workspaces;
        this.broker = broker;
        this.runtimeSessions = runtimeSessions;
        this.bindings = bindings;
    }

    public record Attachment(RuntimeSessionRecord session, RuntimeBindingRecord binding) {
        public Attachment {
            Objects.requireNonNull(session);
            Objects.requireNonNull(binding);
            verify(binding, session);
            if (binding.getState() != RuntimeBindingRecord.State.READY || !session.isAcquirable()) {
                throw unavailable();
            }
        }

        public static Attachment verify(SessionRecord session, WorkspaceRuntimeResolver.Resolved resolved,
                RuntimeSessionRecord runtime, RuntimeBindingRecord binding) {
            ContextBinding context = session.workspace();
            if (context == null || !context.equals(resolved.binding())
                    || !runtime.getSession().getScope().equals(resolved.scope())
                    || !binding.getRequest().getScope().equals(resolved.scope())
                    || !session.sessionId().equals(runtime.getSession().getHarnessSessionId())
                    || !ORDINARY_TURN.equals(runtime.getSession().getTurnKind())
                    || !context.getStorageId().equals(binding.getRequest().getStorageId())) {
                throw unavailable();
            }
            verify(binding, runtime);
            return new Attachment(runtime, binding);
        }

        private static void verify(RuntimeBindingRecord binding, RuntimeSessionRecord session) {
            if (binding.getGeneration() != session.getRuntimeGeneration()
                    || !binding.getBindingId().equals(session.getBindingId())
                    || !binding.getRequest().getScope().equals(session.getSession().getScope())) {
                throw unavailable();
            }
            String isolation = binding.getRequest().getScope().getIsolationClass();
            boolean isolated = "session".equals(isolation)
                    ? session.getSession().getHarnessSessionId().equals(binding.getRequest().getIsolationKey())
                    : "workspace".equals(isolation) && binding.getRequest().getIsolationKey() == null;
            if (!isolated || binding.getRequest().getStorageId() == null
                    || binding.getProvisionSeed() == null || binding.getLease() == null
                    || binding.getResourceHandle() == null || binding.getAttestationGeneration() <= 0) {
                throw unavailable();
            }
        }
    }

    public CompletionStage<Attachment> acquire(SessionPrincipal principal, String sessionId) {
        SessionRecord session = sessions.requireReadableSession(principal, sessionId);
        var resolved = workspaces.resolve(sessionId);
        return broker.acquire(sessionId, sessionId, ORDINARY_TURN, null, null)
                .thenApply(runtime -> Attachment.verify(session, resolved, runtime,
                        bindings.findById(runtime.getBindingId())));
    }

    public Attachment inspect(SessionPrincipal principal, String sessionId, String bindingId, long generation) {
        SessionRecord session = sessions.requireReadableSession(principal, sessionId);
        var resolved = workspaces.resolve(sessionId);
        var runtime = runtimeSessions.findById(resolved.scope(), sessionId);
        var binding = bindings.findById(bindingId);
        if (runtime == null || binding == null || binding.getGeneration() != generation
                || !runtime.getSession().getHarnessSessionId().equals(sessionId)
                || !runtime.getSession().getRuntimeSessionId().equals(sessionId)
                || !session.workspace().equals(resolved.binding())
                || !runtime.getSession().getScope().equals(resolved.scope())
                || !binding.getRequest().getScope().equals(resolved.scope())
                || !binding.getBindingId().equals(runtime.getBindingId())
                || binding.getGeneration() != runtime.getRuntimeGeneration()
                || !binding.getRequest().getStorageId().equals(session.workspace().getStorageId())) {
            throw unavailable();
        }
        return new Attachment(runtime, binding);
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "workspace_attachment_unverified",
                "The Runtime attachment does not match the authorized Session and its Workspace.", false);
    }
}
