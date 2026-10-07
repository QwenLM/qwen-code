package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

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

// The ManagedAgentStore javadoc fixes the lock order that keeps InnoDB from
// deadlocking concurrent Turn admissions (issue #11343): the session row FOR
// UPDATE first, then the turn row, in one transaction, for every writer that
// locks both rows. The order lives only in prose, so this source-level
// canary pins it. Selection is fail-closed on the lock itself — a
// requireSessionForUpdate call or a raw managed_agent_session FOR UPDATE —
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

    // Returns the public writers that touch the turn row — directly or one
    // hop through a same-file method — before taking the session-row lock,
    // and collects every public lock-bearing member into locked.
    private static List<String> auditLockOrder(String source,
            List<String> locked) {
        Map<String, List<String>> members = memberBodies(source);
        List<String> violations = new ArrayList<>();
        Matcher declarations = DECLARATION.matcher(source);
        while (declarations.find()) {
            if (!declarations.group(0).startsWith("\n    public")) {
                continue;
            }
            String name = declarations.group(1);
            String body = methodBody(source, declarations.start());
            int sessionLock = sessionLockIndex(body);
            if (sessionLock < 0) {
                continue;
            }
            locked.add(name);
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

    // The index the session-row lock is taken at: the helper call, or the
    // raw session-table FOR UPDATE statement — a member bearing neither
    // spelling is not a locker and answers -1.
    private static int sessionLockIndex(String body) {
        int helper = body.indexOf(LOCK_HELPER);
        if (helper >= 0) {
            return helper;
        }
        return body.contains(SESSION_TABLE) && body.contains(LOCK_MODE)
                ? body.indexOf(SESSION_TABLE)
                : -1;
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
