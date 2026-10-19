package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

/** Actual Hosted producer, Broker HTTP and worker with H2 and an explicit mount facade. */
class WorkspaceCsiHostedFilesTest {
    @TempDir
    Path directory;

    @ParameterizedTest(name = "cold recovery = {0}")
    @ValueSource(booleans = {false, true})
    void hostedFileTurnsRetainResultsAcrossOriginalAndRecoveredOwners(boolean coldRecovery) throws Exception {
        Assumptions.assumeTrue(Files.isRegularFile(Path.of("../../packages/cli/dist/src/serve/hosted-csi-text-turn.js")),
                "Run npm run build to include the Hosted JavaScript acceptance test");
        var source = new DriverManagerDataSource("jdbc:h2:mem:csi-hosted-files-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        try {
            WorkspaceCsiSqlWorkerMySqlIT.acceptance(source, directory, true, coldRecovery);
        } finally {
            new JdbcTemplate(source).execute("SHUTDOWN");
        }
    }
}
