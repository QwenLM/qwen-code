package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Column;

import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Types;
import java.util.List;
import java.util.Locale;

final class WorkspaceCsiApplicationSchema {
    private WorkspaceCsiApplicationSchema() {}

    static boolean matches(ResultSetMetaData metadata, List<Column> columns) throws SQLException {
        int identity = columns.size() + 1;
        if (metadata.getColumnCount() != identity
                || !"id".equalsIgnoreCase(metadata.getColumnName(identity))
                || metadata.getColumnType(identity) != Types.BIGINT
                || !metadata.isAutoIncrement(identity)) {
            return false;
        }
        for (int index = 0; index < columns.size(); index++) {
            Column column = columns.get(index);
            if (!column.name().equals(metadata.getColumnName(index + 1).toLowerCase(Locale.ROOT))
                    || !column.kind().accepts(metadata.getColumnType(index + 1))) {
                return false;
            }
        }
        return true;
    }
}
