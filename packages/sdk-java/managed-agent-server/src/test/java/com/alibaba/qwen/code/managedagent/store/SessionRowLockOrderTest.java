package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.jupiter.api.Test;

// The ManagedAgentStore javadoc fixes the lock order that keeps InnoDB from
// deadlocking concurrent Turn admissions (issue #11343): the session row FOR
// UPDATE first, then the turn row, in one transaction, for every writer that
// locks both rows. The order lives only in prose, so this source-level
// canary pins it: any public writer that takes the session-row lock must be
// @Transactional and must not touch the turn row before the lock —
// regardless of whether the turn-row access goes through a requireTurn
// helper or a raw managed_agent_turn statement like recordAdmission's.
class SessionRowLockOrderTest {
    private static final Path SOURCE = Path.of("src", "main", "java",
            "com", "alibaba", "qwen", "code", "managedagent", "store",
            "ManagedAgentStore.java");
    private static final Pattern DECLARATION = Pattern.compile(
            "\n    public [^\n]+? (\\w+)\\(");
    private static final List<String> TURN_ROW_ACCESS = List.of(
            "requireTurn(", "requireTurnForUpdate(", "managed_agent_turn");

    @Test
    void mutationEntriesAcquireTheSessionRowLockBeforeAnyTurnRowAccess()
            throws IOException {
        String source = Files.readString(SOURCE);
        List<String> locked = new ArrayList<>();
        Matcher declarations = DECLARATION.matcher(source);
        while (declarations.find()) {
            String body = methodBody(source, declarations.start());
            if (!body.contains("requireSessionForUpdate")) {
                continue;
            }
            locked.add(declarations.group(1));
            assertThat(body).as(declarations.group(1)
                            + " is transactional, so the session-row lock"
                            + " outlives the statement")
                    .contains("@Transactional");
            int sessionLock = body.indexOf("requireSessionForUpdate");
            int turnRowAccess = firstIndexOf(body, TURN_ROW_ACCESS);
            assertThat(turnRowAccess < 0 || sessionLock < turnRowAccess)
                    .as(declarations.group(1)
                            + " acquires the session-row lock before any"
                            + " turn-row access")
                    .isTrue();
        }
        // The derivation is only evidence if it finds the writers the
        // deadlock was reported on — including recordAdmission, which
        // reaches the turn row through raw SQL instead of a helper.
        assertThat(locked).contains("insertCancelCommand", "recordAdmission",
                "cancelBeforeAdmission", "failTurn");
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
