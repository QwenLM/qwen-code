package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ConditionalExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MemberReferenceTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.ParenthesizedTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreeScanner;
import java.io.IOException;
import java.lang.reflect.Method;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
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
// canary pins it. The audit reads the JDK compiler's own parse tree and
// keeps its resolution rules small enough to state exactly:
//
// - Members are keyed by (enclosing type, name, parameter type text) and
//   nested types are harvested recursively, so an overload can neither hide
//   behind its sibling's lock nor credit a lock its own body never takes,
//   and a helper moved into a nested type stays visible.
// - A call resolves to exactly one member: through the caller's enclosing
//   type chain for a bare or this. call, through the named type for a
//   Type. call. A reference the audit cannot resolve to one member — an
//   overload set tied on name and arity, a call on a receiver whose type
//   the parse cannot see, a method reference whose arity is not spelled —
//   is never guessed: when every candidate provably reaches neither the
//   session lock nor the turn row the reference is skipped and pinned in
//   an exactly-asserted exemption set, and otherwise the audit throws.
// - SQL spellings are read from literals, their concatenations, class
//   constants and references to them; comments never reach the tree, so
//   they can never spoof a needle. The lock side credits only the text
//   every branch of a conditional carries — a `flag ? " FOR UPDATE" : ""`
//   appends no unconditional lock — while the turn side credits either
//   branch. Calls embedded in a concatenation are still followed as calls.
// - A session-row lock is counted only from a spelling that names the
//   session table — a FOR UPDATE on another table in the same body is not
//   the lock — and the implicit row lock of an INSERT or UPDATE on the
//   session table counts, which is what admits the create path: it writes
//   the session row before the turn row.
// - Anonymous class bodies fold into the enclosing member (their methods
//   answer only through the interface they implement), and calls that
//   leave the file are outside the audit; the sibling boundary below pins
//   which files lock the session row or touch the turn row at all.
//   Transactionality is runtime wiring — a Spring proxy, or a
//   TransactionTemplate in another file's caller — not a spelling a
//   same-file parse can see, so the audit pins the order, not the
//   annotation.
class SessionRowLockOrderTest {
    private static final Path STORE_PACKAGE = Path.of("src", "main", "java",
            "com", "alibaba", "qwen", "code", "managedagent", "store");
    private static final String MANAGED_AGENT_STORE = "ManagedAgentStore.java";
    private static final String SESSION_TABLE = "managed_agent_session";
    private static final String TURN_TABLE = "managed_agent_turn";
    private static final String LOCK_MODE = "FOR UPDATE";

    // Sibling stores that take an unconditional session-row lock today.
    // None writes the turn row, so the session-first order has nothing to
    // bite on there; the one that also reads it is order-audited below.
    // WorkspaceRecoveryStore is deliberately absent: its session-row lock
    // rides a `lockSources ? " FOR UPDATE" : ""` conditional, and a lock
    // taken on only some branches is not the lock this canary pins. A new
    // sibling locker — or a new sibling turn-row access — fails here
    // instead of passing unaudited.
    private static final Set<String> SIBLING_SESSION_LOCKERS = Set.of(
            "ManagedActionStore.java", "ManagedExtensionRecordStore.java",
            "ManagedSessionStore.java", "ManagedToolResultStore.java",
            "WorkspaceLifecycleStore.java");
    private static final Set<String> SIBLING_TURN_READERS = Set.of(
            "ChildResultRelayStore.java", "ManagedActionStore.java",
            "ManagedToolResultProjector.java", "WorkspaceExecutionStore.java",
            "WorkspaceMigrationStore.java", "WorkspaceRecoveryStore.java");

    // The package's unresolvable-but-benign references, pinned exactly per
    // file: calls on receivers whose type the parse cannot see (a
    // JsonNode's path, a lambda's row, a field of a nested type) whose
    // name and arity collide with same-file members, and overload sets
    // tied on name and arity. Every candidate of every pinned reference
    // provably reaches neither the session lock nor the turn row — a
    // candidate that starts reaching a side throws instead of exempting —
    // and the pin is asserted exactly, so a new unresolvable reference or
    // a stale entry fails the sibling boundary test.
    private static final Map<String, Set<String>> AMBIGUITY_EXEMPTIONS =
            Map.ofEntries(
                    Map.entry("ManagedAgentDefinitionStore.java",
                            Set.of("ManagedAgentDefinitionStore.notFound/0",
                                    "ManagedAgentDefinitionStore.row/2",
                                    "ManagedAgentDefinitionStore.update/7")),
                    Map.entry("ManagedArtifactReader.java",
                            Set.of("ManagedArtifactReader.open/1",
                                    "ManagedArtifactReader.readRange/3",
                                    "ManagedArtifactReader.readRange/5")),
                    Map.entry("ManagedExtensionRecordStore.java",
                            Set.of("ManagedExtensionRecordStore.sha256/1",
                                    "ManagedExtensionRecordStore.storedRow/2")),
                    Map.entry("ManagedExtensionRecords.java",
                            Set.of("ManagedExtensionRecords.concat/2",
                                    "ManagedExtensionRecords.require/2")),
                    Map.entry("ManagedSessionStore.java",
                            Set.of("ManagedSessionStore.storedTransaction/1")),
                    Map.entry("ManagedTaskEventStore.java",
                            Set.of("ManagedTaskEventStore.eventRow/2")),
                    Map.entry("ManagedToolResultProjector.java",
                            Set.of("ManagedToolResultProjector.require/2")),
                    Map.entry("ManagedToolResultStore.java",
                            Set.of("ManagedToolResultStore.artifact/2",
                                    "Source.sessionKey/0")),
                    Map.entry("ManagedWorkspaceRegistry.java",
                            Set.of("ManagedWorkspaceRegistry.findReadable/3")),
                    Map.entry("ToolPublicationAdmissionStore.java",
                            Set.of("AcknowledgementBundle.captureIdentity/0",
                                    "AcknowledgementBundle.finished/0",
                                    "AcknowledgementBundle.outcomeRef/0",
                                    "ToolPublicationAdmissionStore.usesDataSource/1")),
                    Map.entry("ToolPublicationContract.java",
                            Set.of("ToolPublicationContract.digest/1",
                                    "ToolPublicationContract.id/1")),
                    Map.entry("ToolPublicationDataStore.java",
                            Set.of("ToolPublicationDataStore.hash/1",
                                    "ToolPublicationDataStore.lockOriginalSettledResult/3",
                                    "ToolPublicationDataStore.requireStagedCall/2",
                                    "ToolPublicationDataStore.usesDataSource/1",
                                    "VerificationBudget.timeout/2",
                                    "VerifiedAcknowledgement.catalog/0",
                                    "VerifiedAcknowledgement.finished/0",
                                    "VerifiedStream.readRange/3",
                                    "VerifiedStream.size/0")),
                    Map.entry("ToolPublicationRetentionStore.java",
                            Set.of("ReadLease.check/0",
                                    "ReadLease.close/0",
                                    "ToolPublicationRetentionStore.open/4")),
                    Map.entry("ToolPublicationStore.java",
                            Set.of("HeadActivation.current/5",
                                    "Original.csi/0",
                                    "Row.withState/2",
                                    "ToolPublicationStore.usesDataSource/1")),
                    Map.entry("WorkspaceCsiCheckpointSnapshotStore.java",
                            Set.of("WorkspaceCsiCheckpointSnapshotStore.hash/1",
                                    "WorkspaceCsiCheckpointSnapshotStore.parse/1",
                                    "WorkspaceCsiCheckpointSnapshotStore.scope/1")),
                    Map.entry("WorkspaceCsiWorkerAckStore.java",
                            Set.of("WorkspaceCsiWorkerAckStore.decode/1")),
                    Map.entry("WorkspaceExecutionStore.java",
                            Set.of("WorkspaceExecutionStore.digest/1")),
                    Map.entry("WorkspaceMigrationStore.java",
                            Set.of("WorkspaceMigrationStore.inspect/0",
                                    "WorkspaceMigrationStore.path/1")),
                    Map.entry("WorkspaceOperatorRecoveryStore.java",
                            Set.of("WorkspaceOperatorRecoveryStore.blocked/0",
                                    "WorkspaceOperatorRecoveryStore.digest/1")),
                    Map.entry("WorkspaceRecoveryStore.java",
                            Set.of("WorkspaceRecoveryStore.digest/0",
                                    "WorkspaceRecoveryStore.hash/1",
                                    "WorkspaceRecoveryStore.parse/1")),
                    Map.entry("WorkspaceStorageGuard.java",
                            Set.of("IdentityReader.read/1")));

    private record Key(String owner, String name, List<String> paramTypes) {
        int arity() {
            return paramTypes.size();
        }

        String ownerSimpleName() {
            return owner.substring(owner.lastIndexOf('.') + 1);
        }

        // The pin-able identity of an ambiguous reference: owner, name and
        // arity — the parameter types are exactly what the candidates
        // cannot be told apart by.
        String handle() {
            return ownerSimpleName() + "." + name + "/" + arity();
        }
    }

    // One ordered step in a member body: a SQL spelling (callee == null,
    // lock/turn flag what the text bears) or a call to a same-file member
    // (callee set, flags unused).
    private record Event(boolean lock, boolean turn, Key callee) { }

    // A call or method reference the audit could not resolve to one member.
    private record Ambiguous(Key caller, String handle,
            List<Key> candidates) { }

    private record Audit(List<String> members, Set<String> lockers,
            List<String> violations, Set<String> lockersWithoutTurnAccess,
            Set<String> exemptions, boolean locksSessionRow,
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
        // The reference the parse cannot resolve to one member —
        // ItemRow.toRecord behind the lambda parameter at the item read —
        // is pinned exactly: a new unresolvable reference fails here, and
        // this entry goes stale the day the call is typed or moved.
        assertThat(audit.exemptions())
                .containsExactly("ItemRow.toRecord/1");
        // The harvest is asserted against the bytecode's own enumeration,
        // recursively over nested types and as a multiset: a member the
        // parse dropped — including one of two overloads sharing a
        // name/arity key — would let a writer pass unaudited.
        assertThat(audit.members())
                .as("the parse must see every compiled member")
                .isEqualTo(compiledMembers(ManagedAgentStore.class,
                        audit.members()));
    }

    // The session-first order is audited on every store whose writers lock
    // the session row and touch the turn row — the audited population is
    // derived from the computed locker/reader sets, never named, so a
    // sibling that starts doing both lands in it without an edit here. The
    // boundary itself is pinned exactly, so the audit's universe cannot
    // drift either: a sibling that starts locking the session row or
    // reading the turn row fails the set assertions.
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
        // A tripwire over the derivation, not its source: the audited set
        // is whatever the locker/reader intersection computed.
        Set<String> orderAudited = new TreeSet<>(sessionLockers);
        orderAudited.retainAll(turnReaders);
        assertThat(orderAudited).containsExactly("ManagedActionStore.java");
        // ManagedActionStore.admit takes the tenant lock before the
        // session row and never touches the turn row — the file's single
        // turn read lives in a locker-less query method — so it stays
        // violation-free under the same order audit the main file gets.
        for (String name : orderAudited) {
            assertThat(audits.get(name).violations())
                    .as("%s keeps the session-first order", name).isEmpty();
        }
        Map<String, Set<String>> exemptions = new TreeMap<>();
        for (Map.Entry<String, Audit> entry : audits.entrySet()) {
            if (!entry.getValue().exemptions().isEmpty()) {
                exemptions.put(entry.getKey(), entry.getValue().exemptions());
            }
        }
        assertThat(exemptions).isEqualTo(AMBIGUITY_EXEMPTIONS);
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

    // A lock delegated to a nested type in the same file is the harvest's
    // business too: the writer calls the nested helper by its type name,
    // the edge resolves, and the inversion is reported — the shape a
    // nested-type harvest miss used to hide entirely.
    @Test
    void theAuditFollowsTheLockIntoANestedType() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void inlineWriter(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    @Transactional
                    public void nestedLockWriter(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                        Nested.lockSession(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }

                    static class Nested {

                        static void lockSession(String tenantId,
                                String sessionId) {
                            jdbc.queryForMap("SELECT session_id FROM"
                                    + " managed_agent_session FOR UPDATE");
                        }
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).containsExactlyInAnyOrder(
                "inlineWriter", "nestedLockWriter");
        assertThat(audit.lockers()).containsExactlyInAnyOrder(
                "inlineWriter", "nestedLockWriter", "lockSession");
    }

    // A nested type reached through an instance is the same member: the
    // receiver's type is not spelled at the call, so the audit refuses to
    // guess — the helper reaches the session lock, and the unresolvable
    // call throws instead of passing unaudited.
    @Test
    void theAuditThrowsOnANestedLockBehindAnUntypedReceiver() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void fieldLockWriter(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                        nested.lockSession(tenantId, sessionId);
                    }

                    static class Nested {

                        void lockSession(String tenantId,
                                String sessionId) {
                            jdbc.queryForMap("SELECT session_id FROM"
                                    + " managed_agent_session FOR UPDATE");
                        }
                    }
                }
                """;
        assertThatThrownBy(() -> audit(synthetic))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("lockSession")
                .hasMessageContaining("fieldLockWriter");
    }

    // Two overloads tied on name and arity collapse under a (name, arity)
    // key, so a call to either is never attributed: when one candidate
    // reaches the session lock the audit throws, because attributing the
    // call to a chosen member would hide or invent an order.
    @Test
    void theAuditThrowsOnAnAmbiguousCallReachingALock() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void writer(String tenantId, String sessionId) {
                        helper(tenantId);
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void helper(String tenantId) {
                        requireSessionForUpdate(tenantId, tenantId);
                    }

                    private void helper(Integer sequence) {
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThatThrownBy(() -> audit(synthetic))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("helper/1")
                .hasMessageContaining("writer");
    }

    // The same ambiguity is exempt — and pinned — when every candidate
    // provably reaches neither side: the call is skipped because any
    // resolution answers the same audit. The pin is asserted exactly, so a
    // candidate that starts reaching a side turns the exemption into a
    // throw instead of silently absorbing it.
    @Test
    void theAuditExemptsABenignAmbiguousCall() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void writer(String tenantId, String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                        format(tenantId);
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'RUNNING'");
                    }

                    private void format(String tenantId) {
                    }

                    private void format(Integer sequence) {
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
        assertThat(audit.lockers()).containsExactly("writer");
        assertThat(audit.exemptions())
                .containsExactly("SyntheticStore.format/1");
    }

    // A method reference is a call whose arity is not spelled: it is never
    // resolved silently. A reference to a member that reaches the turn row
    // throws, because crediting it at the reference site would order the
    // invocation where it is mentioned, not where it runs.
    @Test
    void theAuditThrowsOnAMethodReferenceReachingTheTurnRow() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void writer(String tenantId, String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                        Runnable later = this::writeTurnRow;
                    }

                    private void writeTurnRow() {
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
        assertThatThrownBy(() -> audit(synthetic))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("writeTurnRow")
                .hasMessageContaining("writer");
    }

    // A lock that rides only one branch of a conditional is not the
    // unconditional session-row lock this canary pins: WorkspaceRecovery-
    // Store's `lockSources ? " FOR UPDATE" : ""` shape credits no lock, so
    // the writer stays out of the locker set — while the turn-row write on
    // the same statement is still seen.
    @Test
    void theAuditDoesNotCreditAConditionalLock() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void conditionalLockWriter(String tenantId,
                            String sessionId, boolean locking) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session WHERE session_id"
                                + " = ?" + (locking ? " FOR UPDATE" : ""));
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.lockers()).isEmpty();
        assertThat(audit.violations()).isEmpty();
        assertThat(audit.touchesTurnRow()).isTrue();
    }

    // The turn side scores either branch: a turn access that executes only
    // under a flag still inverts the order on the runs that take that
    // branch, so a writer whose conditional turn read precedes the
    // unconditional lock violates.
    @Test
    void theAuditCreditsATurnAccessOnEitherBranch() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void conditionalTurnWriter(String tenantId,
                            String sessionId, boolean counting) {
                        jdbc.queryForMap(counting
                                ? "SELECT COUNT(*) FROM managed_agent_turn"
                                : "SELECT COUNT(*) FROM managed_agent_event");
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
                "conditionalTurnWriter");
    }

    // A call embedded in a SQL concatenation is still a call: the spelling
    // is scored from the flattened text and the invocation is followed, so
    // a helper hop inside the string cannot hide the helper's own turn-row
    // access — the writer's statement names neither table, and only the
    // followed edge puts the turn write ahead of the lock.
    @Test
    void theAuditFollowsACallEmbeddedInASqlConcatenation() {
        String synthetic = """
                class SyntheticStore {

                    @Transactional
                    public void embeddingWriter(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE managed_agent_event SET note = '"
                                + auditTrail() + "'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private String auditTrail() {
                        jdbc.update("UPDATE managed_agent_turn SET status"
                                + " = 'FAILED'");
                        return "m";
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "embeddingWriter");
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

    // Member identity carries the parameter types: a call to the
    // non-locking overload must not inherit the lock position only its
    // locking sibling takes.
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
        Map<String, String> lockConstants = new HashMap<>();
        Map<String, String> turnConstants = new HashMap<>();
        for (Tree declaration : unit.getTypeDecls()) {
            if (declaration instanceof ClassTree type) {
                harvest(type, "", methods, lockConstants, turnConstants);
            }
        }
        List<Ambiguous> ambiguous = new ArrayList<>();
        Map<Key, List<Event>> events = new LinkedHashMap<>();
        for (Map.Entry<Key, MethodTree> member : methods.entrySet()) {
            events.put(member.getKey(), eventsOf(member.getValue(),
                    member.getKey(), methods, lockConstants, turnConstants,
                    ambiguous));
        }
        Set<Key> lockReaching = reaching(events, true);
        Set<Key> turnReaching = reaching(events, false);
        // An unresolvable reference is exempt only while every candidate
        // provably reaches neither side; the moment one does, the audit
        // fails closed instead of guessing an attribution.
        Set<String> exemptions = new TreeSet<>();
        for (Ambiguous reference : ambiguous) {
            boolean sideReaching = reference.candidates().stream()
                    .anyMatch(candidate -> lockReaching.contains(candidate)
                            || turnReaching.contains(candidate));
            if (sideReaching) {
                throw new IllegalStateException("cannot resolve the '"
                        + reference.handle() + "' reference in "
                        + reference.caller().handle() + " to one member — "
                        + "a candidate reaches the session lock or the turn"
                        + " row, so the call must be disambiguated by arity"
                        + " or renamed");
            }
            exemptions.add(reference.handle());
        }
        Set<String> lockers = new TreeSet<>();
        Set<String> lockersWithoutTurnAccess = new TreeSet<>();
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
            if (!turnReaching.contains(key)) {
                lockersWithoutTurnAccess.add(key.name());
                continue;
            }
            if (lockAfterTurn(key, events, lockReaching, turnReaching,
                    new HashSet<>())) {
                violations.add(key.name());
            }
        }
        List<String> members = methods.keySet().stream()
                .map(key -> key.ownerSimpleName() + "#" + key.name() + "/"
                        + key.arity())
                .sorted().collect(Collectors.toCollection(ArrayList::new));
        return new Audit(members, lockers, violations,
                lockersWithoutTurnAccess, exemptions,
                events.values().stream().flatMap(List::stream)
                        .anyMatch(Event::lock),
                events.values().stream().flatMap(List::stream)
                        .anyMatch(Event::turn));
    }

    // The members of one type, recursively through its nested types, keyed
    // by (enclosing type, name, parameter type text): same-name overloads
    // that share an arity stay distinct members, and a nested type's
    // member is harvested exactly like a top-level one. Constants answer
    // their flattened initializer per side, so a conditional lock clause in
    // a constant scores exactly like the inline spelling.
    private static void harvest(ClassTree type, String ownerPath,
            Map<Key, MethodTree> methods, Map<String, String> lockConstants,
            Map<String, String> turnConstants) {
        String path = ownerPath.isEmpty() ? type.getSimpleName().toString()
                : ownerPath + "." + type.getSimpleName();
        for (Tree member : type.getMembers()) {
            if (member instanceof MethodTree method
                    && !method.getName().contentEquals("<init>")) {
                List<String> paramTypes = new ArrayList<>();
                for (VariableTree parameter : method.getParameters()) {
                    paramTypes.add(String.valueOf(parameter.getType()));
                }
                methods.put(new Key(path, method.getName().toString(),
                        paramTypes), method);
            } else if (member instanceof VariableTree field
                    && field.getModifiers().getFlags()
                            .contains(Modifier.STATIC)
                    && field.getModifiers().getFlags()
                            .contains(Modifier.FINAL)
                    && field.getInitializer() != null
                    && "String".equals(String.valueOf(field.getType()))) {
                lockConstants.put(field.getName().toString(),
                        flatten(field.getInitializer(), lockConstants, true));
                turnConstants.put(field.getName().toString(),
                        flatten(field.getInitializer(), turnConstants,
                                false));
            } else if (member instanceof ClassTree nested) {
                harvest(nested, path, methods, lockConstants, turnConstants);
            }
        }
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
    // members, in the parse tree's visit order. Concatenations flatten per
    // side before the needle scan, so a split literal cannot hide a table
    // name and a conditional clause credits the lock side only with the
    // text every branch carries; the calls the flattened text embeds are
    // still followed.
    private static List<Event> eventsOf(MethodTree method, Key caller,
            Map<Key, MethodTree> methods, Map<String, String> lockConstants,
            Map<String, String> turnConstants, List<Ambiguous> ambiguous) {
        List<Event> events = new ArrayList<>();
        if (method.getBody() == null) {
            return events;
        }
        new TreeScanner<Void, Void>() {
            @Override
            public Void visitMethodInvocation(MethodInvocationTree node,
                    Void unused) {
                addCall(node);
                return super.visitMethodInvocation(node, unused);
            }

            @Override
            public Void visitMemberReference(MemberReferenceTree node,
                    Void unused) {
                addReference(node);
                return super.visitMemberReference(node, unused);
            }

            @Override
            public Void visitBinary(BinaryTree node, Void unused) {
                if (node.getKind() == Tree.Kind.PLUS) {
                    String lockText = flatten(node, lockConstants, true);
                    String turnText = flatten(node, turnConstants, false);
                    if (!lockText.isEmpty() || !turnText.isEmpty()) {
                        addSpelling(lockText, turnText, events);
                        scanCalls(node);
                        return null;
                    }
                }
                return super.visitBinary(node, unused);
            }

            @Override
            public Void visitConditionalExpression(
                    ConditionalExpressionTree node, Void unused) {
                String lockText = flatten(node, lockConstants, true);
                String turnText = flatten(node, turnConstants, false);
                if (!lockText.isEmpty() || !turnText.isEmpty()) {
                    addSpelling(lockText, turnText, events);
                    scanCalls(node);
                    return null;
                }
                return super.visitConditionalExpression(node, unused);
            }

            @Override
            public Void visitLiteral(LiteralTree node, Void unused) {
                if (node.getValue() instanceof String text) {
                    addSpelling(text, text, events);
                }
                return null;
            }

            @Override
            public Void visitIdentifier(IdentifierTree node, Void unused) {
                String name = node.getName().toString();
                if (lockConstants.containsKey(name)) {
                    addSpelling(lockConstants.get(name),
                            turnConstants.get(name), events);
                }
                return null;
            }

            // The calls and references inside an expression whose spelling
            // was already scored: the SQL text is flattened once, but the
            // member calls it embeds keep their own audit edges.
            private void scanCalls(Tree node) {
                new TreeScanner<Void, Void>() {
                    @Override
                    public Void visitMethodInvocation(
                            MethodInvocationTree call, Void unused) {
                        addCall(call);
                        return super.visitMethodInvocation(call, unused);
                    }

                    @Override
                    public Void visitMemberReference(
                            MemberReferenceTree reference, Void unused) {
                        addReference(reference);
                        return super.visitMemberReference(reference, unused);
                    }
                }.scan(node, null);
            }

            private void addCall(MethodInvocationTree node) {
                resolve(node.getMethodSelect(), node.getArguments().size(),
                        caller, methods, ambiguous).forEach(key ->
                        events.add(new Event(false, false, key)));
            }

            // A method reference is an invocation whose argument count is
            // not spelled, so it can never resolve to one member: it is
            // exempt when every same-named member is benign and throws
            // otherwise.
            private void addReference(MemberReferenceTree node) {
                if (node.getName().contentEquals("<init>")) {
                    return;
                }
                List<Key> candidates = methods.keySet().stream()
                        .filter(key -> key.name()
                                .contentEquals(node.getName().toString()))
                        .toList();
                if (!candidates.isEmpty()) {
                    ambiguous.add(new Ambiguous(caller,
                            handle(candidates),
                            candidates));
                }
            }
        }.scan(method.getBody(), null);
        return events;
    }

    // The same-file member an invocation resolves to, or the reference
    // recorded as ambiguous. A bare or this. call searches the caller's
    // enclosing type chain innermost first; a Type. call searches the
    // named type. Any other receiver hides its type from the parse, so the
    // call is never resolved — it is exempt when every same-named member
    // is benign and throws otherwise.
    private static List<Key> resolve(Tree select, int argCount, Key caller,
            Map<Key, MethodTree> methods, List<Ambiguous> ambiguous) {
        if (select instanceof IdentifierTree identifier) {
            return resolveInOwnerChain(identifier.getName().toString(),
                    argCount, caller, methods, ambiguous);
        }
        if (select instanceof MemberSelectTree memberSelect) {
            String name = memberSelect.getIdentifier().toString();
            if (memberSelect.getExpression() instanceof IdentifierTree base) {
                if (base.getName().contentEquals("this")) {
                    return resolveInOwnerChain(name, argCount, caller,
                            methods, ambiguous);
                }
                List<Key> inType = methods.keySet().stream()
                        .filter(key -> key.ownerSimpleName()
                                .contentEquals(base.getName().toString())
                                && key.name().contentEquals(name)
                                && key.arity() == argCount)
                        .toList();
                if (inType.size() == 1) {
                    return List.of(inType.getFirst());
                }
                if (!inType.isEmpty()) {
                    ambiguous.add(new Ambiguous(caller,
                            inType.getFirst().handle(), inType));
                    return List.of();
                }
            }
            List<Key> any = methods.keySet().stream()
                    .filter(key -> key.name().contentEquals(name)
                            && key.arity() == argCount)
                    .toList();
            if (!any.isEmpty()) {
                ambiguous.add(new Ambiguous(caller, handle(any), any));
            }
        }
        return List.of();
    }

    private static List<Key> resolveInOwnerChain(String name, int argCount,
            Key caller, Map<Key, MethodTree> methods,
            List<Ambiguous> ambiguous) {
        for (String owner = caller.owner(); owner != null;
                owner = owner.lastIndexOf('.') < 0 ? null
                        : owner.substring(0, owner.lastIndexOf('.'))) {
            String scope = owner;
            List<Key> candidates = methods.keySet().stream()
                    .filter(key -> key.owner().equals(scope)
                            && key.name().contentEquals(name)
                            && key.arity() == argCount)
                    .toList();
            if (candidates.size() == 1) {
                return List.of(candidates.getFirst());
            }
            if (!candidates.isEmpty()) {
                ambiguous.add(new Ambiguous(caller,
                        candidates.getFirst().handle(), candidates));
                return List.of();
            }
        }
        return List.of();
    }

    private static String handle(List<Key> candidates) {
        return candidates.stream().map(Key::handle).distinct().sorted()
                .collect(Collectors.joining("|"));
    }

    private static void addSpelling(String lockText, String turnText,
            List<Event> events) {
        boolean lock = lockText.contains("INSERT INTO " + SESSION_TABLE)
                || lockText.contains("UPDATE " + SESSION_TABLE)
                || (lockText.contains(SESSION_TABLE)
                        && lockText.contains(LOCK_MODE));
        boolean turn = turnText.contains(TURN_TABLE);
        if (lock || turn) {
            events.add(new Event(lock, turn, null));
        }
    }

    // The static text an expression can carry, per side: string literals,
    // their concatenations, class constants and the branches of a
    // conditional. The lock side takes only the text both branches carry;
    // the turn side takes either branch. Dynamic parts contribute nothing,
    // and a needle split across a literal boundary still lands in the
    // joined text.
    private static String flatten(Tree node, Map<String, String> constants,
            boolean lockSide) {
        if (node instanceof LiteralTree literal
                && literal.getValue() instanceof String text) {
            return text;
        }
        if (node instanceof BinaryTree binary
                && binary.getKind() == Tree.Kind.PLUS) {
            return flatten(binary.getLeftOperand(), constants, lockSide)
                    + flatten(binary.getRightOperand(), constants, lockSide);
        }
        if (node instanceof ParenthesizedTree parenthesized) {
            return flatten(parenthesized.getExpression(), constants,
                    lockSide);
        }
        if (node instanceof ConditionalExpressionTree conditional) {
            String whenTrue = flatten(conditional.getTrueExpression(),
                    constants, lockSide);
            String whenFalse = flatten(conditional.getFalseExpression(),
                    constants, lockSide);
            return lockSide ? commonText(whenTrue, whenFalse)
                    : whenTrue + whenFalse;
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

    // The text present on every branch, as the shared prefix and suffix of
    // the two flattened arms: `" FOR UPDATE"` against `""` shares nothing,
    // so a conditional lock clause credits no unconditional lock.
    private static String commonText(String whenTrue, String whenFalse) {
        int prefix = 0;
        int bound = Math.min(whenTrue.length(), whenFalse.length());
        while (prefix < bound
                && whenTrue.charAt(prefix) == whenFalse.charAt(prefix)) {
            prefix++;
        }
        int suffix = 0;
        while (suffix < bound - prefix
                && whenTrue.charAt(whenTrue.length() - 1 - suffix)
                        == whenFalse.charAt(whenFalse.length() - 1 - suffix)) {
            suffix++;
        }
        return whenTrue.substring(0, prefix)
                + whenTrue.substring(whenTrue.length() - suffix);
    }

    // The bytecode's own member enumeration, recursively over the named
    // nested types and projected to owner#name/arity, for the harvest
    // cross-check. Anonymous classes are skipped: their bodies fold into
    // the enclosing member on the parse side, and their methods answer
    // only through the implemented interface. Compiler-generated record
    // members — the component accessors and toString/equals/hashCode — are
    // absent from the parse tree unless the record declares them, so only
    // the undeclared ones are filtered.
    private static List<String> compiledMembers(Class<?> type,
            List<String> parsed) {
        List<String> compiled = new ArrayList<>();
        collectCompiled(type, parsed, compiled);
        compiled.sort(null);
        return compiled;
    }

    private static void collectCompiled(Class<?> type, List<String> parsed,
            List<String> compiled) {
        if (type.getSimpleName().isEmpty()) {
            return;
        }
        Set<String> generated = new HashSet<>();
        if (type.isRecord()) {
            for (var component : type.getRecordComponents()) {
                generated.add(component.getName() + "/0");
            }
            generated.add("toString/0");
            generated.add("hashCode/0");
            generated.add("equals/1");
        }
        for (Method method : type.getDeclaredMethods()) {
            if (method.isSynthetic()) {
                continue;
            }
            String member = type.getSimpleName() + "#" + method.getName()
                    + "/" + method.getParameterCount();
            if (generated.contains(method.getName() + "/"
                    + method.getParameterCount())
                    && !parsed.contains(member)) {
                continue;
            }
            compiled.add(member);
        }
        for (Class<?> nested : type.getDeclaredClasses()) {
            collectCompiled(nested, parsed, compiled);
        }
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
