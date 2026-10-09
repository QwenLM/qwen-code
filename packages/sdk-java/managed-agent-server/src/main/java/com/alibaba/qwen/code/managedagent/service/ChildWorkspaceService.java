package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore;
import com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.Row;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceRelativePath;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;
import java.util.function.Supplier;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.APPLYING;
import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.BLOCKED;
import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.CONFLICTED;
import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.DISCARD;
import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.DISCARDED;
import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.DISCARDING;
import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.FAILED;
import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.MERGE;
import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.MERGED;
import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.MERGING;
import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.PREPARING;
import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.READY;
import static com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.columns;

/**
 * The child Workspace of the isolation slice (#13753 I1): prepares a Git
 * linked worktree inside the parent's storage from a snapshot of the
 * parent's working tree, and finishes it by a three-way merge back into
 * that tree or by a discard. Each step runs under a claim of the row and
 * a maintenance hold on the storage lease, reconciles from the row and
 * the disk, and commits by compare-and-set, so a restart, a second worker
 * or an expired claim re-runs the same idempotent steps. Callers drive
 * the steps synchronously; the scan resumes whatever they left. See
 * docs/design/2026-10-09-managed-child-workspace.md.
 */
@Service
public class ChildWorkspaceService {
    private static final Logger LOG = LoggerFactory.getLogger(ChildWorkspaceService.class);
    private static final int SCAN_LIMIT = 20;
    /** A claim's life between renewals; a running step renews it every third of it. */
    static final long LEASE_MS = 120_000;
    static final int MAX_ATTEMPTS = 16;
    /** The storage is held by a tool turn: look again soon, at no cost. */
    static final long BUSY_DELAY_MS = 1_000;
    private static final long MAX_BACKOFF_MS = 60_000;
    private static final int MAX_STEPS = 8;

    private final AgentStateStore sessions;
    private final ChildWorkspaceStore store;
    private final WorkspaceExecutionStore leases;
    private final RuntimeWarmer warmer;
    private final Supplier<Long> clock;
    private final String owner;
    private final long renewMillis;
    private final ScheduledExecutorService renewals = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "child-workspace-renewal");
        thread.setDaemon(true);
        return thread;
    });

    @org.springframework.beans.factory.annotation.Autowired
    public ChildWorkspaceService(AgentStateStore sessions, ChildWorkspaceStore store,
            WorkspaceExecutionStore leases, RuntimeWarmer warmer) {
        this(sessions, store, leases, warmer, System::currentTimeMillis,
                "child-workspace-" + UUID.randomUUID(), LEASE_MS / 3);
    }

    ChildWorkspaceService(AgentStateStore sessions, ChildWorkspaceStore store,
            WorkspaceExecutionStore leases, RuntimeWarmer warmer, Supplier<Long> clock, String owner,
            long renewMillis) {
        this.sessions = sessions;
        this.store = store;
        this.leases = leases;
        this.warmer = warmer;
        this.clock = clock;
        this.owner = owner;
        this.renewMillis = renewMillis;
    }

    @PreDestroy
    void stopRenewals() {
        renewals.shutdownNow();
    }

    /**
     * Prepares the child Workspace of one child run from the parent's
     * current binding, or answers the row an earlier call admitted. The
     * answer is the row after the steps this call could drive: ready,
     * still preparing (parked for the scan), or failed with its reason.
     */
    public Row prepare(String tenantId, String parentSessionId, String childRunId) {
        if (warmer.childWorkspaces() == null) {
            throw new ApiException(HttpStatus.CONFLICT, "child_workspace_unsupported",
                    "This host cannot create a child Workspace.");
        }
        SessionRecord parent = sessions.requireSession(tenantId, parentSessionId);
        if (parent.workspace() == null || !"ACTIVE".equals(parent.status())) {
            throw new ApiException(HttpStatus.CONFLICT, "child_parent_unavailable",
                    "The parent Session cannot admit a child.");
        }
        return drive(store.admit(tenantId, parentSessionId, childRunId, parent.workspace(), clock.get()));
    }

    /**
     * Asks a child Workspace to finish by {@code merge} or {@code discard}
     * (decision 8) and drives the steps it can. The answer is the row as
     * those steps left it; a finish the host cannot run yet stays owed.
     */
    public Row finish(String tenantId, String parentSessionId, String childRunId, String finish) {
        return drive(store.requestFinish(tenantId, parentSessionId, childRunId, finish, clock.get()));
    }

    public Row find(String tenantId, String parentSessionId, String childRunId) {
        return store.find(tenantId, parentSessionId, childRunId);
    }

    @Scheduled(scheduler = "childWorkspaceScheduler", fixedDelayString =
            "${qwen.managed-agent.child-workspace.scan-delay:2s}")
    public void scan() {
        if (warmer.childWorkspaces() == null) {
            return;
        }
        for (Row row : store.findDue(clock.get(), SCAN_LIMIT)) {
            try {
                drive(row);
            } catch (RuntimeException error) {
                LOG.warn("child workspace step failed tenant={} parent={} run={} failure={}",
                        row.tenantId(), row.parentSessionId(), row.childRunId(), error.getMessage(), error);
            }
        }
        // After the due rows: a crashed step's row is claimed again above,
        // and its new claimant takes the hold over, so what is left holding
        // a storage here is a hold no step owns any more.
        int released = leases.releaseStaleMaintenance(clock.get());
        if (released > 0) {
            LOG.warn("released {} child workspace maintenance hold(s) no step owned", released);
        }
    }

    static boolean owes(Row row) {
        return switch (row.state()) {
            case PREPARING, MERGING, APPLYING, DISCARDING -> true;
            case READY -> row.finishRequest() != null;
            case CONFLICTED, BLOCKED, FAILED -> DISCARD.equals(row.finishRequest());
            default -> false;
        };
    }

    Row drive(Row row) {
        ChildWorkspaceProvider provider = warmer.childWorkspaces();
        Row current = row;
        for (int step = 0; provider != null && step < MAX_STEPS; step++) {
            long now = clock.get();
            if (!owes(current) || current.nextRetryAt() > now) {
                break;
            }
            Row claimed = store.claim(current, owner, now, LEASE_MS);
            if (claimed == null) {
                break;
            }
            try {
                if (owes(claimed)) {
                    step(provider, claimed);
                }
            } catch (ChildWorkspaceException error) {
                failed(claimed, error);
            } catch (RuntimeBrokerException error) {
                if ("workspace_busy".equals(error.getCode())) {
                    store.retry(claimed, owner, false, clock.get() + BUSY_DELAY_MS,
                            error.getMessage(), clock.get());
                } else {
                    retry(claimed, error.getCode(), error.getMessage());
                }
            } catch (ApiException error) {
                retry(claimed, error.getCode(), error.getMessage());
            } catch (RuntimeException error) {
                // Unforeseen faults count too, so they end blocked instead
                // of retrying on every scan.
                retry(claimed, "child_workspace_error", String.valueOf(error.getMessage()));
                LOG.warn("child workspace step failed tenant={} parent={} run={}", claimed.tenantId(),
                        claimed.parentSessionId(), claimed.childRunId(), error);
            } finally {
                store.release(claimed, owner, clock.get());
            }
            current = store.find(row.tenantId(), row.parentSessionId(), row.childRunId());
        }
        return current;
    }

    private void step(ChildWorkspaceProvider provider, Row claimed) {
        switch (claimed.state()) {
            case PREPARING -> {
                if (DISCARD.equals(claimed.finishRequest())) {
                    advance(claimed, DISCARDING, columns());
                } else {
                    prepareStep(provider, claimed);
                }
            }
            case READY -> advance(claimed, MERGE.equals(claimed.finishRequest()) ? MERGING : DISCARDING,
                    columns());
            case MERGING -> mergeStep(provider, claimed);
            case APPLYING -> applyStep(provider, claimed);
            case DISCARDING -> discardStep(provider, claimed);
            case CONFLICTED, BLOCKED, FAILED -> advance(claimed, DISCARDING, columns());
            default -> throw new IllegalStateException("A " + claimed.state() + " child Workspace owes no step");
        }
    }

    private void prepareStep(ChildWorkspaceProvider provider, Row claimed) {
        ChildWorktreeGit git = provider.git();
        held(provider, claimed, root -> {
            String base = claimed.baseCommit();
            String childCwd = claimed.childCwdRelative();
            ChildWorktreeGit.Repository repository;
            if (base == null) {
                ChildWorktreeGit.Layout layout = git.layout(root, claimed.parentCwdRelative());
                childCwd = childCwd(claimed.childWorkspaceId(), layout.offset());
                repository = git.open(root, layout.repositoryRelative());
                base = git.snapshot(root, repository, repository.top(), null);
                if (!git.hasDirectory(root, repository, base, layout.offset())) {
                    throw new ChildWorkspaceException(ChildWorkspaceException.LAYOUT, false,
                            "The parent's working directory holds nothing the snapshot carries");
                }
                advance(claimed, PREPARING, columns("repository_relative", layout.repositoryRelative(),
                        "child_cwd_relative", childCwd, "base_commit", base));
            } else {
                repository = git.open(root, claimed.repositoryRelative());
            }
            git.create(root, repository, claimed.childWorkspaceId(), base);
            Path directory = root.resolve(childCwd).normalize();
            if (!directory.startsWith(root) || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
                throw ChildWorkspaceException.diverged("The child's working directory is missing");
            }
            return null;
        });
        advance(claimed, READY, columns());
    }

    /**
     * The child's working directory, held to the rule every Session
     * directory meets: the reserved prefix can push a deep parent
     * directory past its 1024 code points, and that is a layout refusal.
     */
    static String childCwd(String childWorkspaceId, String offset) {
        String cwd = ChildWorktreeGit.childCwd(childWorkspaceId, offset);
        try {
            if (!WorkspaceRelativePath.normalize(cwd).equals(cwd)) {
                throw new ChildWorkspaceException(ChildWorkspaceException.LAYOUT, false,
                        "The child's working directory is not in normal form");
            }
        } catch (WorkspaceException error) {
            throw new ChildWorkspaceException(ChildWorkspaceException.LAYOUT, false,
                    "The child's working directory is not a valid Session directory");
        }
        return cwd;
    }

    private void mergeStep(ChildWorkspaceProvider provider, Row claimed) {
        ChildWorktreeGit git = provider.git();
        String id = claimed.childWorkspaceId();
        held(provider, claimed, root -> {
            ChildWorktreeGit.Repository repository = git.open(root, claimed.repositoryRelative());
            String result = claimed.resultCommit();
            if (result == null) {
                result = git.result(root, repository, id, claimed.baseCommit());
                git.pin(root, repository, id, "result", result);
                advance(claimed, MERGING, columns("result_commit", result));
            }
            ChildWorktreeGit.Merge merge = git.merge(root, repository, claimed.baseCommit(), result);
            if (merge.clean()) {
                advance(claimed, APPLYING, columns("parent_tree", merge.parentTree(),
                        "merged_tree", merge.mergedTree()));
                // The write follows under the same hold: a tool turn waiting
                // for the storage must not change the parent's tree between
                // the merge and its write.
                Row applying = store.find(claimed.tenantId(), claimed.parentSessionId(), claimed.childRunId());
                write(git, root, repository, applying);
                advance(applying, MERGED, columns("outcome_code", "merged"));
                return null;
            }
            // The child's result stays pinned: a conflict never loses work.
            git.discard(root, claimed.repositoryRelative(), id, true);
            List<String> conflicts = merge.conflicts().size() > ChildWorktreeGit.MAX_CONFLICT_PATHS
                    ? merge.conflicts().subList(0, ChildWorktreeGit.MAX_CONFLICT_PATHS) : merge.conflicts();
            advance(claimed, CONFLICTED, columns("parent_tree", merge.parentTree(),
                    "outcome_code", "conflicted", "conflict_paths", conflicts));
            return null;
        });
    }

    private void applyStep(ChildWorkspaceProvider provider, Row claimed) {
        ChildWorktreeGit git = provider.git();
        held(provider, claimed, root -> {
            write(git, root, git.open(root, claimed.repositoryRelative()), claimed);
            return null;
        });
        advance(claimed, MERGED, columns("outcome_code", "merged"));
    }

    /** Writes the recorded merge into the parent's tree, then removes the worktree and both pins. */
    private static void write(ChildWorktreeGit git, Path root, ChildWorktreeGit.Repository repository,
            Row applying) {
        git.apply(root, repository, applying.parentTree(), applying.mergedTree());
        git.discard(root, applying.repositoryRelative(), applying.childWorkspaceId(), false);
    }

    private void discardStep(ChildWorkspaceProvider provider, Row claimed) {
        held(provider, claimed, root -> {
            provider.git().discard(root, claimed.repositoryRelative(), claimed.childWorkspaceId(),
                    claimed.resultCommit() != null);
            return null;
        });
        advance(claimed, DISCARDED, columns("outcome_code",
                claimed.outcomeCode() == null ? "discarded" : claimed.outcomeCode()));
    }

    /**
     * Runs one physical step under the maintenance hold of decision 10,
     * renewing the claim while it runs, so a slow Git command never lets a
     * second worker take a step that is still going. The hold is the
     * storage's, so the binding names the storage root.
     */
    private <T> T held(ChildWorkspaceProvider provider, Row claimed, Function<Path, T> work) {
        AtomicBoolean live = new AtomicBoolean(true);
        AtomicLong renewed = new AtomicLong(clock.get());
        ScheduledFuture<?> renewal = renewals.scheduleWithFixedDelay(() -> {
            try {
                if (store.renew(claimed, owner, clock.get() + LEASE_MS, clock.get())) {
                    renewed.set(clock.get());
                } else {
                    live.set(false);
                }
            } catch (RuntimeException error) {
                // A claim that could not be renewed for most of its life
                // may already belong to another worker.
                if (clock.get() - renewed.get() >= LEASE_MS - renewMillis) {
                    live.set(false);
                }
                LOG.warn("child workspace claim renewal failed run={}", claimed.childRunId(), error);
            }
        }, renewMillis, renewMillis, TimeUnit.MILLISECONDS);
        try {
            ContextBinding storage = new ContextBinding(claimed.tenantId(), claimed.workspaceId(),
                    claimed.workspaceGeneration(), claimed.storageId(), ".",
                    WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
            Path root = provider.storageRoot(storage);
            leases.holdForMaintenance(storage, claimed.childWorkspaceId(), claimed.claimGeneration());
            try {
                return ChildWorktreeGit.whileLive(live::get, () -> work.apply(root));
            } finally {
                leases.releaseMaintenance(storage, claimed.childWorkspaceId(), claimed.claimGeneration());
            }
        } finally {
            renewal.cancel(false);
        }
    }

    private void advance(Row claimed, String toState, java.util.Map<String, Object> columns) {
        if (!store.transition(claimed, owner, toState, columns, clock.get())) {
            throw new ApiException(HttpStatus.CONFLICT, "child_workspace_claim_lost",
                    "The child Workspace moved on under another claim.");
        }
    }

    /**
     * A terminal failure ends the row: {@code failed} while nothing was
     * created (a preparation whose base was never recorded), {@code
     * blocked} after. A retryable one parks the row with backoff. The row
     * is judged as it stands now, since a step may have moved it on before
     * failing.
     */
    private void failed(Row claimed, ChildWorkspaceException error) {
        if (error.retryable()) {
            retry(claimed, error.code(), error.getMessage());
            return;
        }
        Row latest = stillClaimed(claimed);
        if (latest == null) {
            return;
        }
        end(latest, PREPARING.equals(latest.state()) && latest.baseCommit() == null ? FAILED : BLOCKED,
                error.code(), error.getMessage());
    }

    private void retry(Row claimed, String code, String message) {
        Row latest = stillClaimed(claimed);
        if (latest == null) {
            return;
        }
        if (latest.attempts() + 1 >= MAX_ATTEMPTS) {
            end(latest, BLOCKED, code, message);
            return;
        }
        long backoff = Math.min(MAX_BACKOFF_MS, 1_000L << Math.min(latest.attempts(), 6));
        store.retry(latest, owner, true, clock.get() + backoff, truncate(message), clock.get());
    }

    /**
     * Ends the row. A discard that cannot finish clears the discard
     * request with it: {@code blocked} must not lead straight back into
     * the discard that just failed, so only a new request retries it.
     */
    private void end(Row latest, String state, String code, String message) {
        java.util.Map<String, Object> columns = columns("outcome_code", code, "last_error", truncate(message));
        if (DISCARDING.equals(latest.state())) {
            columns.put("finish_request", null);
        }
        store.transition(latest, owner, state, columns, clock.get());
    }

    /** The row as it stands, while this worker's claim still holds it. */
    private Row stillClaimed(Row claimed) {
        Row latest = store.find(claimed.tenantId(), claimed.parentSessionId(), claimed.childRunId());
        return latest != null && latest.claimGeneration() == claimed.claimGeneration()
                && owner.equals(latest.claimedBy()) ? latest : null;
    }

    private static String truncate(String text) {
        return text == null || text.length() <= 1024 ? text : text.substring(0, 1024);
    }
}
