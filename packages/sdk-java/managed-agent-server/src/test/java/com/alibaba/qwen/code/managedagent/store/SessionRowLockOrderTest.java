package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The InnoDB deadlock fix is exactly the three `requireSessionForUpdate`
 * prologues in `recordAdmission` / `cancelBeforeAdmission` / `failTurn`:
 * every turn-row mutation must be preceded by the session-row lock so all
 * writers take InnoDB locks in session-first order. A concurrency test
 * cannot deterministically observe the lock order, so this pins the
 * structural invariant — deleting or moving a prologue below a turn-row
 * access trips it immediately.
 */
class SessionRowLockOrderTest {
    private static final Path SOURCE = Path.of("src/main/java",
            "com/alibaba/qwen/code/managedagent/store",
            "ManagedAgentStore.java");

    @Test
    void mutationEntriesAcquireTheSessionRowLockBeforeAnyTurnRowAccess()
            throws IOException {
        String source = Files.readString(SOURCE);
        for (String method : List.of("recordAdmission",
                "cancelBeforeAdmission", "failTurn")) {
            String body = methodBody(source, method);
            int sessionLock = body.indexOf("requireSessionForUpdate");
            int turnRowAccess = firstIndexOf(body, "requireTurn(",
                    "requireTurnForUpdate(", "insertCancelCommand(");
            assertThat(sessionLock).as(method + " locks the session row")
                    .isGreaterThanOrEqualTo(0);
            assertThat(turnRowAccess < 0 || sessionLock < turnRowAccess)
                    .as(method + " takes the session row lock before any"
                            + " turn-row access")
                    .isTrue();
        }
    }

    private static String methodBody(String source, String method) {
        int start = source.indexOf(" " + method + "(");
        assertThat(start).as(method + " is declared").isGreaterThanOrEqualTo(0);
        int declarationStart = source.lastIndexOf('}', start) + 1;
        int nextPublic = source.indexOf("\n    public ", start + 1);
        int nextPrivate = source.indexOf("\n    private ", start + 1);
        int end = Math.min(nextPublic < 0 ? source.length() : nextPublic,
                nextPrivate < 0 ? source.length() : nextPrivate);
        assertThat(end).isGreaterThan(start);
        return source.substring(declarationStart, end);
    }

    private static int firstIndexOf(String text, String... needles) {
        int first = -1;
        for (String needle : needles) {
            int index = text.indexOf(needle);
            if (index >= 0 && (first < 0 || index < first)) {
                first = index;
            }
        }
        return first;
    }
}
