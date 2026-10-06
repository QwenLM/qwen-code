package com.alibaba.qwen.code.managedagent;

import java.util.HashSet;
import java.util.Set;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;

/**
 * The one-shot backfills behind the upgrade witnesses of
 * {@link ManagedAgentMySqlIT}: each applies only to the rows present when
 * it runs, so its witness is valid only when its migration was still
 * pending at the run's start. Gating all of them on one shared flag reads
 * a database left mid-window by an interrupted or older run as a first
 * pass (the V2-derived count then fails) or as a rerun (the V17 and V29
 * witnesses then silently skip).
 */
record BackfillWitnesses(boolean consumerProgress, boolean eventIdentity,
        boolean pendingOperations, boolean hookAdmissions,
        boolean reseedCreationScope) {
    static BackfillWitnesses forApplied(Set<String> appliedAtStart) {
        return new BackfillWitnesses(!appliedAtStart.contains("2"),
                !appliedAtStart.contains("15"), !appliedAtStart.contains("17"),
                !appliedAtStart.contains("29"), appliedAtStart.contains("9"));
    }

    /** Versions Flyway had applied before this run migrates anything. */
    static Set<String> appliedVersions(DataSource dataSource) {
        Set<String> versions = new HashSet<>();
        for (MigrationInfo info : Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().info()
                .applied()) {
            if (info.getVersion() != null) {
                versions.add(info.getVersion().toString());
            }
        }
        return versions;
    }
}
