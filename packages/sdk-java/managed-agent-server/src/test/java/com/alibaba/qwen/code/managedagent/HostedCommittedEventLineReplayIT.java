package com.alibaba.qwen.code.managedagent;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

            const [module, input] = process.argv.slice(2);
            const { parseManagedSessionEvent } = await import(module);
            const events = JSON.parse(readFileSync(input, 'utf8'));
            let failed = 0;
            for (const [index, event] of events.entries()) {
              try {
                parseManagedSessionEvent(event);
              } catch (error) {
                failed += 1;
                console.error(`event ${index}: ${error.message}`);
              }
            }
            process.exit(failed === 0 ? 0 : 1);
            """;

    @Test
    void readerAcceptsTheCommittedEventShapes() throws Exception {
        ObjectNode sessionKey = JSON.createObjectNode()
                .put("tenantId", "tenant-1").put("workspaceId", "workspace-1")
                .put("sessionId", "session-1");
        ArrayNode events = JSON.createArrayNode();
        events.add(PublicationJournalFixture.eventNode(1,
                "activation.changed", PublicationJournalFixture
                        .activation("active"), sessionKey, 1));
        events.add(PublicationJournalFixture.eventNode(2, "tool.intent",
                PublicationJournalFixture.intentPayload(
                        PublicationJournalFixture.ref("args-1",
                                "managed-tool-input",
                                JSON.createObjectNode())), sessionKey, 1));
        events.add(PublicationJournalFixture.eventNode(3,
                "checkpoint.committed", PublicationJournalFixture
                        .checkpointPayload("checkpoint-1"), sessionKey, 1));
        events.add(TurnEventLines.inputAcceptedEvent("tenant-store",
                "workspace-store", "session-store"));
        // The byte-budget test's dense delta, at the reader's text cap.
        events.add(TurnEventLines.messageDeltaEvent("tenant-store",
                "workspace-store", "budget-session", 1, "a".repeat(
                        TurnEventLines.MAX_DELTA_TEXT_BYTES)));
        Path root = Files.createTempDirectory("event-line-replay");
        Path input = root.resolve("events.json");
        Files.writeString(input, events.toString(), StandardCharsets.UTF_8);
        Path script = root.resolve("reader-replay.mts");
        Files.writeString(script, DRIVER, StandardCharsets.UTF_8);
        Path repo = Path.of(System.getProperty("user.dir")).getParent()
                .getParent().getParent();
        String node = System.getProperty("qwen.node",
                System.getProperty("node.executable", "node"));
        Process reader = new ProcessBuilder(node, "--import", "tsx",
                script.toString(), repo.resolve("packages/core/src/"
                        + "managed-runtime/managed-session-records.ts")
                        .toUri().toString(), input.toString())
                .directory(repo.toFile()).redirectErrorStream(true).start();
        assertThat(reader.waitFor(120, TimeUnit.SECONDS)).isTrue();
        String output = new String(reader.getInputStream().readAllBytes(),
                StandardCharsets.UTF_8);
        assertThat(reader.exitValue()).as("reader replay output: %s", output)
                .isZero();
    }
}
