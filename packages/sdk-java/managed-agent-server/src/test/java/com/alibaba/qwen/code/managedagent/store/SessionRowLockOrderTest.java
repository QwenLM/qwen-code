package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.jupiter.api.Test;

// recordAdmission's inline comment fixes the lock order that keeps InnoDB
// from deadlocking concurrent Turn admissions: the session row FOR UPDATE
// first, then the turn row, in one transaction, for every writer that locks
// both rows. The order lives only in that prose, so this source-level
// canary pins it. Comments carry no weight — only code counts. Selection is
// fail-closed on the lock itself — a requireSessionForUpdate call or a raw
// managed_agent_session FOR UPDATE, taken directly or one helper hop deep —
// turn-row access resolves one hop through the same-file methods a writer
// calls, and the locker set is asserted exactly, so a new locker fails here
// instead of escaping the audit.
class SessionRowLockOrderTest {
    private static final Path SOURCE = Path.of("src", "main", "java",
            "com", "alibaba", "qwen", "code", "managedagent", "store",
            "ManagedAgentStore.java");
    private static final Pattern DECLARATION = Pattern.compile(
            "\n    (?:public|private) [^\n]+? (\\w+)\\(");
    private static final List<String> TURN_ROW_ACCESS = List.of(
            "requireTurn(", "requireTurnForUpdate(", "managed_agent_turn");
    private static final String LOCK_HELPER = "requireSessionForUpdate";
    private static final String SESSION_TABLE = "managed_agent_session";
    private static final String LOCK_MODE = "FOR UPDATE";

    @Test
    void mutationEntriesAcquireTheSessionRowLockBeforeAnyTurnRowAccess()
            throws IOException {
        String source = Files.readString(SOURCE);
        List<String> locked = new ArrayList<>();
        assertThat(auditLockOrder(source, locked)).isEmpty();
        // The derivation is only evidence if it accounts for every writer
        // that takes the session-row lock, so the set is asserted exactly:
        // a locker this list does not name fails here instead of passing
        // unaudited. It includes the writers the deadlock was reported on,
        // recordAdmission's raw-SQL turn-row access, and the raw FOR UPDATE
        // lockers no helper name would find.
        assertThat(locked).containsExactlyInAnyOrder("insertTurnCommand",
                "insertCancelCommand", "beginSessionMutation",
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
        assertThat(auditLockOrder(synthetic, new ArrayList<>()))
                .containsExactly("badWriter");
    }

    // A comment that names the lock helper is prose, not a lock: the real
    // lock call comes after the turn-row write, so the writer violates.
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
        assertThat(auditLockOrder(synthetic, new ArrayList<>()))
                .containsExactly("proseWriter");
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
        List<String> locked = new ArrayList<>();
        assertThat(auditLockOrder(synthetic, locked)).isEmpty();
        assertThat(locked).containsExactly("helperLockWriter");
    }

    // A declaration directly under a // comment line is still a member: the
    // stripper blanks the comment's text but keeps its newline, so the
    // declaration's \n prefix survives and the audit visits it.
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
        assertThat(auditLockOrder(synthetic, new ArrayList<>()))
                .containsExactly("badWriter");
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
        assertThat(auditLockOrder(synthetic, new ArrayList<>()))
                .containsExactly("lateLockWriter");
    }

    // The parity guard is the fail-closed half of the strip: a comment
    // shaped like a member declaration matches in the raw source but not
    // after the strip, and that drift must fail the canary instead of
    // silently dropping a member from the audit.
    @Test
    void theStripperMustNotDropADeclaration() {
        String synthetic = """
                class SyntheticStore {

                    /*
                    A comment line shaped like a member declaration:
                    public void ghost(String tenantId) {
                    */

                    @Transactional
                    public void writer(String tenantId, String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " managed_agent_session FOR UPDATE");
                    }
                }
                """;
        assertThatThrownBy(() -> auditLockOrder(synthetic,
                new ArrayList<>()))
                .isInstanceOf(AssertionError.class)
                .hasMessageContaining("ghost");
    }

    // Returns the public writers that touch the turn row — directly or one
    // hop through a same-file method — before taking the session-row lock,
    // and collects every public lock-bearing member into locked.
    private static List<String> auditLockOrder(String source,
            List<String> locked) {
        String code = stripComments(source);
        // Fail closed on stripper or regex drift: a declaration the strip
        // loses never enters the member map, so the audit can never visit
        // it.
        List<String> declared = declarationsOf(source);
        List<String> kept = declarationsOf(code);
        if (!declared.equals(kept)) {
            List<String> lost = new ArrayList<>(declared);
            kept.forEach(lost::remove);
            throw new AssertionError("stripComments dropped declarations "
                    + lost);
        }
        Map<String, List<String>> members = memberBodies(code);
        List<String> violations = new ArrayList<>();
        Matcher declarations = DECLARATION.matcher(code);
        while (declarations.find()) {
            if (!declarations.group(0).startsWith("\n    public")) {
                continue;
            }
            String name = declarations.group(1);
            String body = methodBody(code, declarations.start());
            int sessionLock = sessionLockIndex(body, name, members);
            if (sessionLock < 0) {
                continue;
            }
            // Overloads audit as separate declarations but name one locker.
            if (!locked.contains(name)) {
                locked.add(name);
            }
            assertThat(body).as(name + " is transactional, so the"
                    + " session-row lock outlives the statement")
                    .contains("@Transactional");
            int turnRowAccess = firstTurnRowAccess(body, name, members);
            if (turnRowAccess >= 0 && sessionLock > turnRowAccess) {
                violations.add(name);
            }
        }
        return violations;
    }

    private static List<String> declarationsOf(String source) {
        List<String> names = new ArrayList<>();
        Matcher declarations = DECLARATION.matcher(source);
        while (declarations.find()) {
            names.add(declarations.group(1));
        }
        return names;
    }

    // The index the session-row lock is taken at: the helper call or raw
    // session-table FOR UPDATE in this body, or one hop through a same-file
    // member whose own body bears either spelling — a member reaching the
    // lock neither way is not a locker and answers -1. One hop matches the
    // turn-row side; two-hop lock paths like insertSessionCommand's would
    // need transitive resolution this canary deliberately does not attempt.
    private static int sessionLockIndex(String body, String self,
            Map<String, List<String>> members) {
        int first = directLockIndex(body);
        for (Map.Entry<String, List<String>> member : members.entrySet()) {
            if (member.getKey().equals(self)) {
                continue;
            }
            int call = body.indexOf(member.getKey() + "(");
            if (call < 0) {
                continue;
            }
            boolean calleeLocks = member.getValue().stream()
                    .anyMatch(slice -> directLockIndex(slice) >= 0);
            if (calleeLocks && (first < 0 || call < first)) {
                first = call;
            }
        }
        return first;
    }

    private static int directLockIndex(String body) {
        int helper = body.indexOf(LOCK_HELPER);
        if (helper >= 0) {
            return helper;
        }
        // The lock is scored at its FOR UPDATE, not the table's first
        // mention: a body that reads the session row before locking it
        // mentions the table long before the lock statement.
        return body.contains(SESSION_TABLE) && body.contains(LOCK_MODE)
                ? body.indexOf(LOCK_MODE)
                : -1;
    }

    // Comments are prose, not code: naming the lock helper in a comment must
    // not count as taking the lock. String literals stay — the raw-SQL
    // needles live inside them. The comment's characters are blanked but
    // every newline survives, so a declaration directly under a comment line
    // keeps the \n prefix DECLARATION matches on.
    private static String stripComments(String text) {
        StringBuilder out = new StringBuilder(text.length());
        boolean inString = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (inString) {
                out.append(c);
                if (c == '\\' && i + 1 < text.length()) {
                    out.append(text.charAt(++i));
                } else if (c == '"') {
                    inString = false;
                }
                continue;
            }
            if (c == '"') {
                inString = true;
                out.append(c);
            } else if (c == '/' && i + 1 < text.length()
                    && text.charAt(i + 1) == '/') {
                while (i < text.length() && text.charAt(i) != '\n') {
                    out.append(' ');
                    i++;
                }
                if (i < text.length()) {
                    out.append('\n');
                }
            } else if (c == '/' && i + 1 < text.length()
                    && text.charAt(i + 1) == '*') {
                int end = text.indexOf("*/", i + 2);
                int last = end < 0 ? text.length() : end + 2;
                while (i < last) {
                    char inside = text.charAt(i);
                    out.append(inside == '\n' ? '\n' : ' ');
                    i++;
                }
                i--;
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    // The earliest turn-row access: a direct needle, or a call to a
    // same-file member whose own body touches the turn row. Overloads share
    // a name, so any matching body marks the callee — over-approximating a
    // canary is safe, under-approximating it is what the finding measured.
    private static int firstTurnRowAccess(String body, String self,
            Map<String, List<String>> members) {
        int first = firstIndexOf(body, TURN_ROW_ACCESS);
        for (Map.Entry<String, List<String>> member : members.entrySet()) {
            if (member.getKey().equals(self)) {
                continue;
            }
            int call = body.indexOf(member.getKey() + "(");
            if (call < 0) {
                continue;
            }
            boolean touchesTurnRow = member.getValue().stream()
                    .anyMatch(slice -> firstIndexOf(slice,
                            TURN_ROW_ACCESS) >= 0);
            if (touchesTurnRow && (first < 0 || call < first)) {
                first = call;
            }
        }
        return first;
    }

    private static Map<String, List<String>> memberBodies(String source) {
        Map<String, List<String>> members = new HashMap<>();
        Matcher declarations = DECLARATION.matcher(source);
        while (declarations.find()) {
            members.computeIfAbsent(declarations.group(1),
                    ignored -> new ArrayList<>())
                    .add(methodBody(source, declarations.start()));
        }
        return members;
    }

    // The slice of one member: from the end of the previous member to the
    // next public or private declaration.
    private static String methodBody(String source, int declarationStart) {
        int start = source.lastIndexOf('}', declarationStart) + 1;
        int nextPublic = source.indexOf("\n    public ", declarationStart + 1);
        int nextPrivate = source.indexOf("\n    private ",
                declarationStart + 1);
        int end = source.length();
        if (nextPublic >= 0) {
            end = nextPublic;
        }
        if (nextPrivate >= 0 && nextPrivate < end) {
            end = nextPrivate;
        }
        String body = source.substring(start, end);
        // The next member's annotations sit between this method's closing
        // brace and its declaration; cut them out so one method's
        // @Transactional cannot cover for another's.
        int closing = body.lastIndexOf("\n    }");
        return closing < 0 ? body : body.substring(0, closing);
    }

    private static int firstIndexOf(String body, List<String> needles) {
        int first = -1;
        for (String needle : needles) {
            int index = body.indexOf(needle);
            if (index >= 0 && (first < 0 || index < first)) {
                first = index;
            }
        }
        return first;
    }
}
