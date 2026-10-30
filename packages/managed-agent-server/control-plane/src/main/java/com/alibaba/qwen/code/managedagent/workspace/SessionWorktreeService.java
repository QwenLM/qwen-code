package com.alibaba.qwen.code.managedagent.workspace;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.ChildWorkspaceException;
import com.alibaba.qwen.code.managedagent.contracts.workspace.SessionWorktreeOperations;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Descriptor;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Plan;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Row;
import com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.annotation.PreDestroy;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@Service
public class SessionWorktreeService {
    private static final long LEASE_MS = 120_000;
    private final SessionWorktreeStore store;
    private final WorkspaceExecutionStore execution;
    private final ManagedAgentSettings properties;
    private final AgentStateStore sessions;
    private final HarnessCoordinator coordinator;
    private final String owner = "session-worktree-" + UUID.randomUUID();
    private final ScheduledExecutorService renewals = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "session-worktree-renewal");
        thread.setDaemon(true);
        return thread;
    });
    private SessionWorktreeOperations git;
    private SessionWorktreeOperations.Factory gitFactory;
    private WorktreeFiles worktreeFiles;

    @org.springframework.beans.factory.annotation.Autowired
    public void configureWorktreeFiles(WorktreeFiles files, SessionWorktreeOperations.Factory factory) {
        worktreeFiles = files;
        gitFactory = factory;
    }

    public SessionWorktreeService(SessionWorktreeStore store, WorkspaceExecutionStore execution,
            ManagedAgentSettings properties, AgentStateStore sessions, HarnessCoordinator coordinator) {
        this.store = store;
        this.execution = execution;
        this.properties = properties;
        this.sessions = sessions;
        this.coordinator = coordinator;
    }

    public record Request(String baseRef) { }
    public record Options(boolean supported, String reason, String baseCommit, List<String> branches,
            String currentBranch) { }
    public record Inspection(Descriptor worktree, boolean canCleanup, String cleanupBlocker) { }

    public static Request parse(JsonNode value, boolean webShell) {
        String key = webShell ? "baseRef" : "base_ref";
        if (value == null) {
            return null;
        }
        if (!value.isObject() || value.size() > 1 || value.size() == 1 && !value.has(key)
                || value.has(key) && (!value.get(key).isTextual() || value.get(key).asText().isBlank())) {
            throw SessionWorktreeOperations.error("invalid_worktree", "Worktree accepts only an optional local base ref.");
        }
        return new Request(value.has(key) ? value.get(key).asText() : null);
    }

    public boolean enabled() {
        var broker = properties.getRuntimeBroker();
        return broker.isSessionWorktreesEnabled() && broker.isEnabled() && broker.isDurableLocalProcess()
                && "local-process".equals(broker.getProvisioner())
                && "session".equals(broker.getBoundSessionIsolationClass())
                && java.nio.charset.StandardCharsets.UTF_8.name().equalsIgnoreCase(System.getProperty("sun.jnu.encoding", ""))
                && !System.getProperty("os.name", "").toLowerCase(Locale.ROOT).startsWith("windows");
    }

    public Options options(String tenant, String actor, WorkspaceSelection selection, String baseRef) {
        store.authorizeOptions(tenant, actor, selection.workspaceId());
        if (!enabled()) {
            return new Options(false, "worktree_unsupported", null, List.of(), null);
        }
        String currentBranch = null;
        try {
            var source = store.source(tenant, actor, selection);
            currentBranch = git().currentBranch(source.root(), source.resolved().binding().getCwdRelative());
            var located = git().source(source.root(), source.resolved().binding().getCwdRelative(), baseRef);
            return new Options(true, null, located.commit(), located.branches(), currentBranch);
        } catch (RuntimeException exception) {
            return new Options(false, code(exception), null, List.of(), currentBranch);
        }
    }

    public Plan preflight(String tenant, String actor, WorkspaceSelection selection, Request request) {
        if (!enabled()) {
            throw SessionWorktreeOperations.error("worktree_unsupported", "Session worktrees require a supported local Runtime.");
        }
        var source = store.source(tenant, actor, selection);
        try {
            var binding = source.resolved().binding();
            var located = git().source(source.root(), binding.getCwdRelative(), request.baseRef());
            String id = UUID.randomUUID().toString().replace("-", "");
            String target = SessionWorktreeOperations.CONTAINER + "/" + id;
            String cwd = ".".equals(located.offset()) ? target : target + "/" + located.offset();
            return new Plan(tenant, binding.getWorkspaceId(), binding.getWorkspaceGeneration(), binding.getStorageId(),
                    binding.getCwdRelative(), binding.getContextConfigRef(), binding.getContextRevision(), source.root().toString(),
                    worktreeFiles.identity(source.root()), located.repositoryRelative(), located.offset(), located.commonDirectory(),
                    located.commonIdentity(), request.baseRef(), located.commit(), id, target, cwd, "worktree-managed-" + id,
                    source.storageIdentity());
        } catch (ChildWorkspaceException exception) {
            throw SessionWorktreeOperations.error("worktree_layout_unsupported", exception.getMessage());
        }
    }

    public List<Descriptor> list(String tenant, String actor, String workspace) {
        return store.list(tenant, actor, workspace);
    }

    public Inspection inspect(String tenant, String actor, String workspace, String id) {
        Row row = store.get(tenant, actor, workspace, id, false);
        Descriptor descriptor = store.describe(tenant, row.sessionId());
        String blocker = store.cleanupBlocker(row);
        if (blocker == null && "READY".equals(row.state())) {
            try {
                blocker = git().cleanupBlocker(row.plan(), row.identityJson());
            } catch (RuntimeException exception) {
                blocker = code(exception);
            }
        }
        if (!List.of("ready", "failed").contains(descriptor.state()) && blocker == null) {
            blocker = descriptor.errorCode() == null ? "worktree_" + descriptor.state() : descriptor.errorCode();
        }
        if (!row.actor().equals(actor) && blocker == null) {
            blocker = "worktree_forbidden";
        }
        return new Inspection(descriptor, blocker == null, blocker);
    }

    public Descriptor cleanup(String tenant, String actor, String workspace, String id, String key) {
        return store.cleanup(tenant, actor, workspace, id, key).descriptor();
    }

    @Scheduled(scheduler = "sessionWorktreeScheduler", fixedDelayString = "${qwen.managed-agent.session-worktree.scan-delay:1000}")
    public void scan() {
        store.resumeStopped();
        for (String[] failure : store.failedInitialSessions()) {
            sessions.failWorktreeInitialTurns(failure[0], failure[1], failure[2] == null ? "worktree_unavailable" : failure[2]);
        }
        for (Row candidate : store.due()) {
            drive(candidate);
        }
    }

    public void drive(Row candidate) {
        Row row = store.claim(candidate, owner, LEASE_MS);
        if (row == null) {
            return;
        }
        AtomicBoolean live = new AtomicBoolean(true);
        var renewal = renewals.scheduleWithFixedDelay(() -> {
            try {
                if (!store.renew(row, owner, LEASE_MS)) {
                    live.set(false);
                }
            } catch (RuntimeException exception) {
                live.set(false);
            }
        }, LEASE_MS / 3, LEASE_MS / 3, TimeUnit.MILLISECONDS);
        boolean preparing = "PREPARING".equals(row.state());
        try {
            if (preparing && !store.active(row) && row.identityJson() == null) {
                if (java.nio.file.Files.exists(java.nio.file.Path.of(row.plan().root()).resolve(row.plan().worktreeRoot()),
                        java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                    store.complete(row, owner, "READY", worktreeFiles.verify(row.plan(), null), null);
                } else {
                    store.complete(row, owner, "FAILED", null, "worktree_session_closed");
                }
                return;
            }
            String storedBlocker = preparing ? null : store.cleanupBlocker(row);
            if (storedBlocker != null) {
                store.complete(row, owner, "READY", null, storedBlocker);
                return;
            }
            var binding = com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.storageBinding(row.plan());
            String step = execution.holdForMaintenance(binding, row.operationId(), row.generation());
            String identity = null;
            boolean stopped = true;
            try {
                identity = git().runWhileLive(live::get, () -> {
                    if (preparing) {
                        return git().prepare(row.plan());
                    }
                    String blocker = store.cleanupBlocker(row);
                    if (blocker != null) {
                        throw SessionWorktreeOperations.error(blocker, "The Session worktree is still in use or no longer authorized.");
                    }
                    git().cleanup(row.plan(), row.identityJson());
                    return null;
                });
            } catch (ChildWorkspaceException exception) {
                stopped = !ChildWorkspaceException.STOP_UNVERIFIED.equals(exception.code());
                throw exception;
            } finally {
                if (stopped) {
                    execution.releaseMaintenance(binding, row.operationId(), row.generation(), step);
                }
            }
            if (store.complete(row, owner, preparing ? "READY" : "REMOVED", identity, null)
                    && preparing && store.active(row)) {
                coordinator.warmSession(row.tenantId(), row.sessionId());
            }
        } catch (RuntimeException exception) {
            String code = code(exception);
            if (store.maintenanceHeld(row)) {
                code = "maintenance_stop_unverified";
            }
            if ("workspace_busy".equals(code)) {
                store.defer(row, owner, code);
            } else if (!"maintenance_stop_unverified".equals(code) && row.attempts() < 15
                    && (exception instanceof ChildWorkspaceException child && child.retryable()
                    || exception instanceof com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException broker && broker.isRetryable())) {
                store.retry(row, owner, code);
            } else {
                String state = "maintenance_stop_unverified".equals(code) || "worktree_identity_conflict".equals(code)
                        ? "BLOCKED" : preparing ? "FAILED" : "READY";
                store.complete(row, owner, state, null, code);
                if (preparing) {
                    sessions.failWorktreeInitialTurns(row.tenantId(), row.sessionId(), code);
                }
            }
        } finally {
            renewal.cancel(false);
        }
    }

    private synchronized SessionWorktreeOperations git() {
        if (git == null) {
            var broker = properties.getRuntimeBroker();
            git = gitFactory.create(broker.getChildWorkspaceGit(), broker.getChildWorkspaceGitTimeout());
        }
        return git;
    }

    private static String code(RuntimeException exception) {
        if (exception instanceof ManagedAgentException managed) {
            return managed.getCode();
        }
        if (exception instanceof ChildWorkspaceException child) {
            return switch (child.code()) {
                case ChildWorkspaceException.STOP_UNVERIFIED -> "maintenance_stop_unverified";
                case ChildWorkspaceException.LAYOUT -> "worktree_layout_unsupported";
                case ChildWorkspaceException.UNSAFE_CONFIG -> "worktree_config_unsupported";
                default -> "worktree_git_failed";
            };
        }
        if (exception instanceof com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException broker) {
            return broker.getCode();
        }
        return "worktree_git_unavailable";
    }

    @PreDestroy
    void stop() {
        renewals.shutdownNow();
        if (git != null) {
            git.close();
        }
    }
}
