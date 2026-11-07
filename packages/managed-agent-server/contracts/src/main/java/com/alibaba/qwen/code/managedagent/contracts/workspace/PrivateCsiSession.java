package com.alibaba.qwen.code.managedagent.contracts.workspace;
import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
public final class PrivateCsiSession {
    private PrivateCsiSession() { }
    public record Request(WorkspaceCsiRegistration registration, String actorId,
            String idempotencyKey, String requestedRevision, String title, WorkspaceSelection workspace) {
        public Request {
            if (registration == null || workspace == null || !".".equals(workspace.cwdRelative())
                    || actorId == null || actorId.isEmpty()
                    || idempotencyKey == null || !idempotencyKey.matches("[\\x21-\\x7e]{1,128}")
                    || requestedRevision != null && (requestedRevision.isBlank() || requestedRevision.length() > 128)
                    || title != null && title.length() > 512) {
                throw new IllegalArgumentException("Invalid private CSI Session creation request");
            }
            com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(registration.tenantId(), actorId);
        }
    }

    public record Created(String sessionId, String runtimeRequestKey, boolean replayed) {
    }
}
