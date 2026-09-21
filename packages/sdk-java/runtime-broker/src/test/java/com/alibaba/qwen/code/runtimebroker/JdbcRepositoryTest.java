package com.alibaba.qwen.code.runtimebroker;

import java.util.UUID;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class JdbcRepositoryTest {
    @Test
    void repositoriesPreserveTheirContractsAcrossInstances()
            throws Exception {
        JdbcRepositoryContract.verify(dataSource(), "h2");
    }

    private static DataSource dataSource() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:runtime-broker-"
                + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        return dataSource;
    }
}
