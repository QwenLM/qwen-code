package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.source.tree.AnnotationTree;
import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ConditionalExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.ParenthesizedTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreeScanner;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import javax.lang.model.element.Modifier;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;

import org.junit.jupiter.api.Test;

// recordAdmission's inline comment fixes the lock order that keeps InnoDB
// from deadlocking concurrent Turn admissions: the session row FOR UPDATE
// first, then the turn row, in one transaction, for every writer that locks
// both rows. The order lives only in that prose, so this source-level
// canary pins it. The audit reads the JDK compiler's own parse tree rather
// than re-implementing the grammar: member identity is (name, arity), so an
// overload can neither hide behind its sibling's lock nor credit a lock its
// own body never takes, and a package-private or protected member is
// harvested exactly like a public one. Comments can never spoof a needle —
// they are not in the tree — and SQL extracted into a class constant is
// harvested and answered at each reference. Both sides resolve
// transitively through same-file members, so neither a lock nor a turn-row
// access escapes the audit by adding a helper hop. A session-row lock is
// counted only from a spelling that names the session table — a FOR UPDATE
// on another table in the same body is not the lock — and the implicit row
// lock of an INSERT or UPDATE on the session table counts, which is what
// admits the create path: it writes the session row before the turn row.
class SessionRowLockOrderTest {
    private static final Path STORE_PACKAGE = Path.of("src", "main", "java",
            "com", "alibaba", "qwen", "code", "managedagent", "store");
    private static final String MANAGED_AGENT_STORE = "ManagedAgentStore.java";
    private static final String SESSION_TABLE = "managed_agent_session";
    private static final String TURN_TABLE = "managed_agent_turn";
    private static final String LOCK_MODE = "FOR UPDATE";

    // Sibling stores that lock a session row today. None writes the turn
    // row, so the session-first order has nothing to bite on there; the
    // two that read it are order-audited below. A new sibling locker — or
    // a new sibling turn-row access — fails here instead of passing
    // unaudited.
    private static final Set<String> SIBLING_SESSION_LOCKERS = Set.of(
            "ManagedActionStore.java", "ManagedExtensionRecordStore.java",
            "ManagedSessionStore.java", "ManagedToolResultStore.java",
            "WorkspaceLifecycleStore.java", "WorkspaceRecoveryStore.java");
    private static final Set<String> SIBLING_TURN_READERS = Set.of(
            "ChildResultRelayStore.java", "ManagedActionStore.java",
            "ManagedToolResultProjector.java", "WorkspaceExecutionStore.java",
            "WorkspaceMigrationStore.java", "WorkspaceRecoveryStore.java");

    private record Key(String name, int arity) { }

    // One ordered step in a member body: a SQL spelling (callee == null,
    // lock/turn flag what the text bears) or a call to a same-file member
    // (callee set, flags unused).
    private record Event(boolean lock, boolean turn, Key callee) { }

    private record Audit(Set<String> signatures, Set<String> lockers,
            List<String> violations, Set<String> lockersWithoutTurnAccess,
            Set<String> nonTransactionalLockers, boolean locksSessionRow,
            boolean touchesTurnRow) { }

    @Test
    void mutationEntriesAcquireTheSessionRowLockBeforeAnyTurnRowAccess()
            throws IOException {
        Audit audit = audit(Files.readString(STORE_PACKAGE.resolve(
                MANAGED_AGENT_STORE)));
        assertThat(audit.violations()).isEmpty();
        // The derivation is only evidence if it accounts for every writer
        // that takes the session-row lock, so the set is asserted exactly:
        // a locker this list does not name fails here instead of passing
        // unaudited. It includes the writers the deadlock was reported on,
        // recordAdmission's raw-SQL turn-row access, the raw FOR UPDATE
        // lockers no helper name would find, and the three create entries,
        // whose session-row INSERT is the lock.
        assertThat(audit.lockers()).containsExactlyInAnyOrder(
                "insertTurnCommand", "insertCancelCommand",
                "insertSessionCommand", "insertWorkspaceSessionCommand",
                "insertChildSessionCommand", "beginSessionMutation",
                "completeSessionMutation", "beginOperation",
                "beginWorkspaceClose", "beginWorkspaceLifecycle",
                "unarchiveWorkspaceSession", "beginCwdChangeOperation",
                "completeCwdChangeOperation", "completeOperation",
                "advanceReplayFloor", "materializeNextBatch", "bindHarness",
                "bindRecoveredHarness", "recordAdmission",
                "recordRecoveryAdmission", "retractContinuationOutput",
                "retractHarnessTurnOutput", "recordHarnessEvents",
                "cancelBeforeAdmission", "failTurn",
                "appendPublicEventIfAbsent", "appendLiveSessionEventIfAbsent");
        // The comparison population is pinned as exactly as the locker set:
        // a locker that loses its turn-row access must shrink this set
        // loudly instead of silently dropping out of the ordering
        // comparison.
        assertThat(audit.lockersWithoutTurnAccess())
                .containsExactlyInAnyOrder("advanceReplayFloor",
                        "appendLiveSessionEventIfAbsent",
                        "appendPublicEventIfAbsent", "beginSessionMutation",
                        "completeOperation", "completeSessionMutation",
                        "unarchiveWorkspaceSession");
        assertThat(audit.nonTransactionalLockers()).isEmpty();
        // The harvest is asserted against the bytecode's own enumeration:
        // a member the parse dropped would let a writer pass unaudited.
        Set<String> compiled = Arrays.stream(
                ManagedAgentStore.class.getDeclaredMethods())
                .filter(method -> !method.isSynthetic())
                .map(method -> method.getName() + "/"
                        + method.getParameterCount())
                .collect(Collectors.toSet());
        assertThat(audit.signatures())
                .as("the parse must see every compiled member")
                .isEqualTo(compiled);
    }

    // The session-first order is audited on ManagedAgentStore, the only
    // store whose writers lock the session row and the turn row together.
    // The sibling boundary is pinned exactly, so the audit's universe
    // cannot drift: a sibling that starts locking the session row or
    // reading the turn row fails the set assertions, and the two siblings
    // doing both today are order-audited here.
    @Test
    void siblingStoresKeepTheSessionTurnBoundaryPinned() throws IOException {
        Set<String> sessionLockers = new TreeSet<>();
        Set<String> turnReaders = new TreeSet<>();
        List<Path> sources;
        try (var paths = Files.list(STORE_PACKAGE)) {
            sources = paths.filter(path -> path.getFileName().toString()
                    .endsWith(".java")).sorted().toList();
        }
        Map<String, Audit> audits = new LinkedHashMap<>();
        for (Path source : sources) {
            String name = source.getFileName().toString();
            if (MANAGED_AGENT_STORE.equals(name)) {
                continue;
            }
            Audit audit = audit(Files.readString(source));
            audits.put(name, audit);
            if (audit.locksSessionRow()) {
                sessionLockers.add(name);
            }
            if (audit.touchesTurnRow()) {
                turnReaders.add(name);
            }
        }
        assertThat(sessionLockers).isEqualTo(SIBLING_SESSION_LOCKERS);
        assertThat(turnReaders).isEqualTo(SIBLING_TURN_READERS);
        // ManagedActionStore.admit takes the tenant lock before the
        // session row and never touches the turn row — the file's single
        // turn read lives in a locker-less query method — and the recovery
        // store's conditional lock precedes its count read. Both stay
        // violation-free under the same order audit the main file gets.
        assertThat(audits.get("ManagedActionStore.java").violations())
                .isEmpty();
        assertThat(audits.get("WorkspaceRecoveryStore.java").violations())
                .isEmpty();
    }

    // The derivation must report a writer that reaches the turn row through
    // a private helper before taking the session-row lock — the shape that
    // passed unaudited when selection and access were by helper name.
    @Test
    void theAuditReportsATurnRowAccessBeforeTheSessionLock() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void badWriter(String tenantId, String sessionId) {
                        deferTurnRetry(tenantId, sessionId);
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void deferTurnRetry(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "badWriter");
    }

    // A comment that names the lock helper is prose, not a lock: comments
    // never reach the parse tree, so the real lock call comes after the
    // turn-row write and the writer violates.
    @Test
    void aCommentMentioningTheLockHelperIsNotALock() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void proseWriter(String tenantId,
                            String sessionId) {
                        // ordering mirrors requireSessionForUpdate
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "proseWriter");
    }

    // A lock taken one helper hop deep is still a lock: the writer lands in
    // the exact locker set, and the helper call's position is what the
    // ordering is checked against.
    @Test
    void theAuditCountsALockTakenThroughAPrivateHelper() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void helperLockWriter(String tenantId,
                            String sessionId) {
                        lockSession(tenantId, sessionId);
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'RUNNING'");
                    }

                    private void lockSession(String tenantId,
                            String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).isEmpty();
        assertThat(audit.lockers()).containsExactly("helperLockWriter");
    }

    // A comment line above a declaration cannot hide the member: the audit
    // reads the parse tree, where no comment survives.
    @Test
    void aCommentLineAboveADeclarationDoesNotHideIt() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    // ordering note
                    public void badWriter(String tenantId, String sessionId) {
                        deferTurnRetry(tenantId, sessionId);
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void deferTurnRetry(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "badWriter");
    }

    // The lock's position is its FOR UPDATE, not the table's first mention:
    // a writer that reads the session row, writes the turn row and only then
    // locks mentions the session table long before it locks, and scoring the
    // lock at that mention would pass the inversion this canary exists to
    // catch.
    @Test
    void theAuditScoresTheLockAtTheForUpdateStatement() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void lateLockWriter(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session WHERE session_id"
                                + " = ?");
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "lateLockWriter");
    }

    // A FOR UPDATE on another table is not the session lock: the lock side
    // must not score it, or the real session lock below the turn-row write
    // would pass with the inversion this canary exists to catch.
    @Test
    void theAuditScoresOnlyTheSessionRowsForUpdate() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void mixedLockWriter(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT operation_id FROM"
                                + " managed_agent_operation WHERE"
                                + " operation_id = ? FOR UPDATE");
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "mixedLockWriter");
    }

    // The turn side resolves transitively: a writer that reaches the turn
    // row through a two-hop chain before taking the lock is the inversion
    // this canary exists to catch, and one-hop resolution audited it as no
    // access — the ordering was never compared.
    @Test
    void theAuditFollowsTheTurnRowThroughTransitiveCalls() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void deepWriter(String tenantId,
                            String sessionId) {
                        writeTurnRow(tenantId, sessionId);
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void writeTurnRow(String tenantId,
                            String sessionId) {
                        markTurn(tenantId, sessionId);
                    }

                    private void markTurn(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "deepWriter");
    }

    // The lock side resolves transitively too: a writer whose session-row
    // lock sits two helper hops down is still a locker, and its ordering is
    // compared — a one-hop lock side never selected it at all.
    @Test
    void theAuditFollowsTheLockThroughTransitiveCalls() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void deepLockWriter(String tenantId,
                            String sessionId) {
                        writeTurnRow(tenantId, sessionId);
                        lockSession(tenantId, sessionId);
                    }

                    private void writeTurnRow(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void lockSession(String tenantId,
                            String sessionId) {
                        guardSession(tenantId, sessionId);
                    }

                    private void guardSession(String tenantId,
                            String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).containsExactly("deepLockWriter");
        assertThat(audit.lockers()).containsExactly("deepLockWriter");
    }

    // A pure delegator's lock and turn sides resolve to the same call
    // site, so a strict comparison of its own body can never fire: the
    // helper it delegates to reads the session row, writes the turn row
    // and only then locks, and the descent must report the delegator for
    // the inversion its helper commits.
    @Test
    void theAuditDescendsIntoASameSiteDelegate() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void lateLockWriter(String tenantId,
                            String sessionId) {
                        beginLifecycle(tenantId, sessionId);
                    }

                    private void beginLifecycle(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session WHERE session_id"
                                + " = ?");
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "lateLockWriter");
    }

    // A protected writer is an entry point a visibility-anchored matcher
    // used to skip entirely: it never entered the audited set, so the same
    // inversion passed unaudited.
    @Test
    void theAuditAuditsAProtectedWriter() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    protected void protectedWriter(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "protectedWriter");
    }

    // A package-private overload is a member like any other: beside a
    // public same-named sibling it must neither hide from the harvest nor
    // borrow the sibling's clean verdict.
    @Test
    void theAuditAuditsAPackagePrivateOverload() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void beginWorkspaceLifecycle(String tenantId,
                            String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                        writeTurnRow(tenantId, sessionId);
                    }

                    @Transactional
                    void beginWorkspaceLifecycle(String tenantId) {
                        writeTurnRow(tenantId, tenantId);
                        requireSessionForUpdate(tenantId, tenantId);
                    }

                    private void writeTurnRow(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).containsExactly(
                "beginWorkspaceLifecycle");
        assertThat(audit.lockers()).containsExactly(
                "beginWorkspaceLifecycle");
    }

    // Member identity is (name, arity): a call to the non-locking overload
    // must not inherit the lock position only its locking sibling takes.
    @Test
    void theAuditResolvesOverloadsByArity() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void lateLockWriter(String tenantId,
                            String sessionId) {
                        helper(tenantId);
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void helper(String tenantId) {
                        jdbc.update("UPDATE managed_agent_operation SET"
                                + " state = 'DONE'");
                    }

                    private void helper(String tenantId, String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "lateLockWriter");
    }

    // SQL extracted into a class constant is still SQL: the constant's
    // initializer feeds the needle set, so a writer whose turn-row write
    // hides behind a named constant is audited exactly like inline SQL.
    @Test
    void theAuditReadsTheTurnRowSqlFromAClassConstant() {
        String synthetic = """
                class SyntheticStore {

                    private static final String FAIL_TURN = "UPDATE"
                            + " managed_agent_turn SET status = 'FAILED'";

                    @Transactional
                    public void constantWriter(String tenantId,
                            String sessionId) {
                        jdbc.update(FAIL_TURN, tenantId, sessionId);
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "constantWriter");
    }

    // The audit machinery is not tied to the main store: a sibling store's
    // writer is audited by the same walk the boundary guard applies to
    // every source in the package.
    @Test
    void aSiblingStoreWriterIsAudited() {
        String sibling = """
                class SiblingStore {

                    @Transactional
                    public void badWriter(String tenantId, String sessionId) {
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(sibling).violations()).containsExactly(
                "badWriter");
    }

    // Runs the audit over one parsed compilation unit and answers the
    // violation list alongside the pinned populations.
    private static Audit audit(String source) {
        CompilationUnitTree unit = parse(source);
        Map<Key, MethodTree> methods = new LinkedHashMap<>();
        Map<String, String> constants = new HashMap<>();
        for (Tree declaration : unit.getTypeDecls()) {
            if (!(declaration instanceof ClassTree type)) {
                continue;
            }
            for (Tree member : type.getMembers()) {
                if (member instanceof MethodTree method
                        && !method.getName().contentEquals("<init>")) {
                    methods.put(new Key(method.getName().toString(),
                            method.getParameters().size()), method);
                } else if (member instanceof VariableTree field
                        && field.getModifiers().getFlags()
                                .contains(Modifier.STATIC)
                        && field.getModifiers().getFlags()
                                .contains(Modifier.FINAL)
                        && field.getInitializer() != null
                        && "String".equals(field.getType().toString())) {
                    constants.put(field.getName().toString(),
                            flatten(field.getInitializer(), constants));
                }
            }
        }
        Map<Key, List<Event>> events = new LinkedHashMap<>();
        for (Map.Entry<Key, MethodTree> member : methods.entrySet()) {
            events.put(member.getKey(),
                    eventsOf(member.getValue(), methods, constants));
        }
        Set<Key> lockReaching = reaching(events, true);
        Set<Key> turnReaching = reaching(events, false);
        Set<String> lockers = new TreeSet<>();
        Set<String> lockersWithoutTurnAccess = new TreeSet<>();
        Set<String> nonTransactionalLockers = new TreeSet<>();
        List<String> violations = new ArrayList<>();
        for (Map.Entry<Key, MethodTree> member : methods.entrySet()) {
            Key key = member.getKey();
            MethodTree method = member.getValue();
            // A private member enters the audit as a callee of the entry
            // points; the descent compares it in its own body.
            if (method.getModifiers().getFlags().contains(Modifier.PRIVATE)
                    || !lockReaching.contains(key)) {
                continue;
            }
            // Overloads audit as separate members but name one locker.
            lockers.add(key.name());
            if (!isTransactional(method)) {
                nonTransactionalLockers.add(key.name());
            }
            if (!turnReaching.contains(key)) {
                lockersWithoutTurnAccess.add(key.name());
                continue;
            }
            if (lockAfterTurn(key, events, lockReaching, turnReaching,
                    new HashSet<>())) {
                violations.add(key.name());
            }
        }
        return new Audit(
                methods.keySet().stream()
                        .map(key -> key.name() + "/" + key.arity())
                        .collect(Collectors.toCollection(TreeSet::new)),
                lockers, violations, lockersWithoutTurnAccess,
                nonTransactionalLockers,
                events.values().stream().flatMap(List::stream)
                        .anyMatch(Event::lock),
                events.values().stream().flatMap(List::stream)
                        .anyMatch(Event::turn));
    }

    // The ordering comparison for one member, over its events in tree
    // order: the session-row lock must precede the first turn-row access.
    // A call reaching both sides is the delegator shape — the two events
    // sit on the same call site — so the comparison descends into the
    // callee, whose own order is what the site answers. The visited set
    // ends the cycle when a delegate is its own caller's sibling.
    private static boolean lockAfterTurn(Key method,
            Map<Key, List<Event>> events, Set<Key> lockReaching,
            Set<Key> turnReaching, Set<Key> visiting) {
        if (!visiting.add(method)) {
            return false;
        }
        for (Event event : events.getOrDefault(method, List.of())) {
            if (event.callee() != null) {
                boolean lock = lockReaching.contains(event.callee());
                boolean turn = turnReaching.contains(event.callee());
                if (lock && turn) {
                    return lockAfterTurn(event.callee(), events,
                            lockReaching, turnReaching, visiting);
                }
                if (lock) {
                    return false;
                }
                if (turn) {
                    return true;
                }
                continue;
            }
            // A statement whose SQL locks the session row while reading the
            // turn row takes the write lock it declares; the read half is
            // the database's own ordering.
            if (event.lock()) {
                return false;
            }
            return true;
        }
        return false;
    }

    // The members reaching a side, as a fixpoint: a member qualifies when
    // its own body bears the spelling or calls a member already in the
    // set. One-hop resolution audited create's two-hop lock as no lock at
    // all — the writers left the asserted set instead of failing it.
    private static Set<Key> reaching(Map<Key, List<Event>> events,
            boolean lockSide) {
        Set<Key> reaching = new HashSet<>();
        for (boolean grew = true; grew;) {
            grew = false;
            for (Map.Entry<Key, List<Event>> member : events.entrySet()) {
                if (reaching.contains(member.getKey())) {
                    continue;
                }
                for (Event event : member.getValue()) {
                    boolean hit = event.callee() != null
                            ? reaching.contains(event.callee())
                            : lockSide ? event.lock() : event.turn();
                    if (hit) {
                        reaching.add(member.getKey());
                        grew = true;
                        break;
                    }
                }
            }
        }
        return reaching;
    }

    // One member's ordered events: SQL spellings and calls to same-file
    // members, in the parse tree's visit order. String concatenations
    // flatten before the needle scan, so a split literal cannot hide a
    // table name, and a constant reference answers its initializer's text.
    private static List<Event> eventsOf(MethodTree method,
            Map<Key, MethodTree> methods, Map<String, String> constants) {
        List<Event> events = new ArrayList<>();
        if (method.getBody() == null) {
            return events;
        }
        new TreeScanner<Void, Void>() {
            @Override
            public Void visitMethodInvocation(MethodInvocationTree node,
                    Void unused) {
                Key callee = calleeOf(node, methods);
                if (callee != null) {
                    events.add(new Event(false, false, callee));
                }
                return super.visitMethodInvocation(node, unused);
            }

            @Override
            public Void visitBinary(BinaryTree node, Void unused) {
                if (node.getKind() == Tree.Kind.PLUS) {
                    String text = flatten(node, constants);
                    if (!text.isEmpty()) {
                        addSpelling(text, events);
                        return null;
                    }
                }
                return super.visitBinary(node, unused);
            }

            @Override
            public Void visitLiteral(LiteralTree node, Void unused) {
                if (node.getValue() instanceof String text) {
                    addSpelling(text, events);
                }
                return null;
            }

            @Override
            public Void visitIdentifier(IdentifierTree node, Void unused) {
                String text = constants.get(node.getName().toString());
                if (text != null) {
                    addSpelling(text, events);
                }
                return null;
            }
        }.scan(method.getBody(), null);
        return events;
    }

    private static void addSpelling(String sql, List<Event> events) {
        boolean lock = sql.contains("INSERT INTO " + SESSION_TABLE)
                || sql.contains("UPDATE " + SESSION_TABLE)
                || (sql.contains(SESSION_TABLE) && sql.contains(LOCK_MODE));
        boolean turn = sql.contains(TURN_TABLE);
        if (lock || turn) {
            events.add(new Event(lock, turn, null));
        }
    }

    // The static text an expression can carry: string literals, their
    // concatenations, class constants and both arms of a conditional.
    // Dynamic parts contribute nothing, and a needle split across a literal
    // boundary still lands in the joined text.
    private static String flatten(Tree node, Map<String, String> constants) {
        if (node instanceof LiteralTree literal
                && literal.getValue() instanceof String text) {
            return text;
        }
        if (node instanceof BinaryTree binary
                && binary.getKind() == Tree.Kind.PLUS) {
            return flatten(binary.getLeftOperand(), constants)
                    + flatten(binary.getRightOperand(), constants);
        }
        if (node instanceof ParenthesizedTree parenthesized) {
            return flatten(parenthesized.getExpression(), constants);
        }
        if (node instanceof ConditionalExpressionTree conditional) {
            return flatten(conditional.getTrueExpression(), constants)
                    + flatten(conditional.getFalseExpression(), constants);
        }
        if (node instanceof IdentifierTree identifier) {
            return constants.getOrDefault(identifier.getName().toString(),
                    "");
        }
        if (node instanceof MemberSelectTree select) {
            return constants.getOrDefault(select.getIdentifier().toString(),
                    "");
        }
        return "";
    }

    // The same-file member an invocation resolves to, keyed by name and
    // arity — overloads never pool — or null when the call leaves the file.
    private static Key calleeOf(MethodInvocationTree node,
            Map<Key, MethodTree> methods) {
        String name = null;
        if (node.getMethodSelect() instanceof IdentifierTree identifier) {
            name = identifier.getName().toString();
        } else if (node.getMethodSelect() instanceof MemberSelectTree select
                && "this".equals(select.getExpression().toString())) {
            name = select.getIdentifier().toString();
        }
        if (name == null) {
            return null;
        }
        Key key = new Key(name, node.getArguments().size());
        return methods.containsKey(key) ? key : null;
    }

    private static boolean isTransactional(MethodTree method) {
        for (AnnotationTree annotation : method.getModifiers()
                .getAnnotations()) {
            String type = annotation.getAnnotationType().toString();
            if (type.equals("Transactional") || type.endsWith(".Transactional")) {
                return true;
            }
        }
        return false;
    }

    private static CompilationUnitTree parse(String source) {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        JavaFileObject file = new SimpleJavaFileObject(
                URI.create("memory:///SyntheticStore.java"),
                JavaFileObject.Kind.SOURCE) {
            @Override
            public CharSequence getCharContent(boolean ignoreErrors) {
                return source;
            }
        };
        JavacTask task = (JavacTask) compiler.getTask(null, null, null, null,
                null, List.of(file));
        try {
            return task.parse().iterator().next();
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }
}
