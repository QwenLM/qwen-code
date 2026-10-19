package com.alibaba.qwen.code.managedagent.store;

import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.nio.file.Path;
import java.util.UUID;

class WorkspaceCsiLegacyAcceptedBatchTest {
    @TempDir
    Path directory;

    @ParameterizedTest(name = "legacy missing valid member = {0}")
    @ValueSource(booleans = {false, true})
    void recoversAcceptedOnlyLegacyBatchWithoutAdmittingMissingValidMembers(boolean missingValid) throws Exception {
        var source = new DriverManagerDataSource("jdbc:h2:mem:csi-legacy-gap-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        try {
            WorkspaceCsiSqlWorkerMySqlIT.legacyAcceptance(source, directory, missingValid);
        } finally {
            new JdbcTemplate(source).execute("SHUTDOWN");
        }
    }
}
