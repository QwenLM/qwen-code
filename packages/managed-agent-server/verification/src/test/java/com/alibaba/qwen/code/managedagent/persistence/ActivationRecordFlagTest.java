package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The database generates is_activation_record from the journal operation. These
 * cases pin the declared CASE to nothing but its marked branches and ELSE 0, and
 * exercise the stored generated value for every operation the Session Store
 * commits, so a collation or case-folding drift cannot stay latent at run time.
 */
class ActivationRecordFlagTest {
    private static final Pattern TABLE = Pattern.compile("(?s)CREATE TABLE ma_session_journal_tx \\((.*?)\\n\\) ENGINE");
    private static final Pattern GENERATED = Pattern.compile("(?i)\\bis_activation_record\\s+TINYINT\\s+UNSIGNED\\s+"
            + "GENERATED\\s+ALWAYS\\s+AS\\s+\\((CASE\\s+operation\\s+.*?\\s+END)\\)");
    private static final Pattern MARKED = Pattern.compile("(?i)\\bWHEN\\s+'([^']+)'\\s+THEN\\s+1\\b");
    private static final Pattern LITERAL = Pattern.compile("'([^']*)'");

    @Test
    void theGeneratedColumnMarksOnlyItsDeclaredBranches() {
        String expression = generatedExpression();
        // Nothing but the marked branches and ELSE 0.
        String rest = MARKED.matcher(expression).replaceAll(" ").replaceAll("\\s+", " ").trim();
        assertThat(rest.toUpperCase(Locale.ROOT)).isEqualTo("CASE OPERATION ELSE 0 END");
        assertThat(markedOperations(expression)).containsExactlyInAnyOrder("installActivation", "renewActivation");
    }

    @Test
    void theGeneratedFlagMatchesTheDeclaredBranchesForStoredOperations() {
        var source = new DriverManagerDataSource("jdbc:h2:mem:activation-flag-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(source);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        // Every name the CASE mentions, some other names the Session Store
        // commits, and a case variant.
        Set<String> operations = new LinkedHashSet<>();
        Matcher literal = LITERAL.matcher(generatedExpression());
        while (literal.find()) {
            operations.add(literal.group(1));
        }
        operations.addAll(List.of("session.create", "releaseActivation", "commitMessage", "commitCheckpoint",
                "commitFileHistory", "hostedModelAttempt", "settleTurn", "InstallActivation"));
        Set<String> marked = markedOperations(generatedExpression());
        long revision = 0;
        for (String operation : operations) {
            revision++;
            byte[] bytes = ("{\"operation\":\"" + operation + "\"}\n").getBytes(StandardCharsets.UTF_8);
            jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision,"
                    + " command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence,"
                    + " last_sequence, event_count, writer_generation, writer_id, writer_token_hash, activation_epoch,"
                    + " record_encoding, record_bytes, byte_length, record_digest, gmt_create) VALUES ('tenant',"
                    + " 'workspace', 'session', ?, ?, ?, ?, ?, REPEAT('0', 64), 1, 1, 1, 1, 'worker', REPEAT('0', 64),"
                    + " 1, 'identity', ?, ?, ?, 0)", revision, ManagedSchemaKeys.key("command", Long.toString(revision)),
                    "transaction-" + revision, operation, "command-" + revision, bytes, bytes.length,
                    JournalStoreRows.sha256(bytes));
            Integer generated = jdbc.queryForObject("SELECT is_activation_record FROM ma_session_journal_tx"
                    + " WHERE journal_revision = ?", Integer.class, revision);
            assertThat(generated).as(operation).isEqualTo(marked.contains(operation) ? 1 : 0);
        }
    }

    private static Set<String> markedOperations(String expression) {
        Set<String> marked = new LinkedHashSet<>();
        Matcher when = MARKED.matcher(expression);
        while (when.find()) {
            marked.add(when.group(1));
        }
        return marked;
    }

    /** The CASE of the journal table's generated column, comments removed; exactly one. */
    private static String generatedExpression() {
        String schema = ManagedSchema.ddl().replaceAll("(?m)^\\s*--.*$", "");
        Matcher table = TABLE.matcher(schema);
        assertThat(table.find()).as("the journal table").isTrue();
        Matcher generated = GENERATED.matcher(table.group(1));
        assertThat(generated.find()).as("the generated column").isTrue();
        String expression = generated.group(1);
        assertThat(generated.find()).as("one generated column").isFalse();
        return expression;
    }
}
