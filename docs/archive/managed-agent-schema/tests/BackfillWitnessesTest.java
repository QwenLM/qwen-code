package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/**
 * The witness gates of {@link ManagedAgentMySqlIT} against databases staged
 * at each boundary version: a witness opens exactly when its one-shot
 * backfill was still pending at the run's start, so a database left
 * mid-window (V14 keeps the V15, V17 and V29 witnesses open while closing
 * V2's, V16 closes V15's) neither fails the V2-derived count nor silently
 * skips the later witnesses.
 */
class BackfillWitnessesTest {
    @Test
    void gatesFollowTheVersionsPendingAtRunStart() {
        // staged -> (consumerProgress V2, eventIdentity V15,
        // pendingOperations V17, hookAdmissions V29, reseedCreationScope V9)
        assertGates(null, true, true, true, true, false);
        assertGates("1", true, true, true, true, false);
        assertGates("8", false, true, true, true, false);
        assertGates("9", false, true, true, true, true);
        assertGates("14", false, true, true, true, true);
        assertGates("15", false, false, true, true, true);
        assertGates("16", false, false, true, true, true);
        assertGates("17", false, false, false, true, true);
        assertGates("28", false, false, false, true, true);
        assertGates("29", false, false, false, false, true);
        assertGates("head", false, false, false, false, true);
    }

    private static void assertGates(String staged, boolean consumerProgress,
            boolean eventIdentity, boolean pendingOperations,
            boolean hookAdmissions, boolean reseedCreationScope) {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:witness-gates-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        if (staged != null) {
            FluentConfiguration flyway = Flyway.configure()
                    .dataSource(dataSource)
                    .locations("classpath:db/migration");
            if (!"head".equals(staged)) {
                flyway.target(MigrationVersion.fromVersion(staged));
            }
            flyway.load().migrate();
        }
        assertThat(BackfillWitnesses.forApplied(
                BackfillWitnesses.appliedVersions(dataSource)))
                .as("database staged at %s", staged)
                .isEqualTo(new BackfillWitnesses(consumerProgress,
                        eventIdentity, pendingOperations, hookAdmissions,
                        reseedCreationScope));
    }
}
