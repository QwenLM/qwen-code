package com.alibaba.qwen.code.managedagent.session;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Preservation pin: every member javadoc the former AgentStateStore carried
 * must stay present, verbatim modulo indentation, somewhere in the six role
 * interfaces. The inventory is a floor, not a ceiling — new javadocs are
 * welcome, but losing one of these fails here. Guards the P1 implementation
 * split against the masked-text regression that dropped all 48 member docs
 * in the first split attempt.
 */
class AgentStateStoreJavadocPinTest {
    private static final List<String> ROLES = List.of(
            "SessionAdmissionStore", "SessionLifecycleStore", "SessionQueryStore",
            "SessionPolicyStore", "EventProjectionStore", "TurnExecutionStore");

    @Test
    void everyFormerMemberJavadocSurvivesOnTheRoles() throws IOException {
        String inventory = Files.readString(Path.of(
                "src", "test", "resources", "managed-agent", "role-javadoc-inventory.txt"));
        StringBuilder roles = new StringBuilder();
        for (String role : ROLES) {
            roles.append(Files.readString(Path.of("..", "contracts", "src", "main",
                    "java", "com", "alibaba", "qwen", "code", "managedagent",
                    "contracts", "session", role + ".java")));
        }
        String normalizedRoles = normalize(roles.toString());
        List<String> missing = new ArrayList<>();
        for (String block : inventory.split("\n---\n")) {
            if (!normalizedRoles.contains(normalize(block))) {
                missing.add(block.lines().findFirst().orElse("(empty block)"));
            }
        }
        assertThat(missing).as("former member javadocs missing from the roles").isEmpty();
    }

    private static String normalize(String text) {
        return String.join("\n", text.lines().map(String::strip).toList());
    }
}
