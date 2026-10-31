package com.alibaba.qwen.code.managedagent.persistence;

import javax.sql.DataSource;

class LocalStorageAliasMySqlIT extends LocalStorageAliasTest {
    @Override
    DataSource source() {
        return mysqlSource();
    }
}
