package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.springframework.jdbc.core.ArgumentPreparedStatementSetter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.PreparedStatementSetter;
import org.springframework.jdbc.core.RowMapper;

import javax.sql.DataSource;

import java.sql.ParameterMetaData;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Types;
import java.util.Map;

/** Preserves byte-exact schema identities at the JDBC map boundary. */
public class ManagedSchemaJdbcTemplate extends JdbcTemplate {
    public ManagedSchemaJdbcTemplate(DataSource source) {
        super(source);
    }

    @Override
    protected RowMapper<Map<String, Object>> getColumnMapRowMapper() {
        return (row, index) -> ManagedSchemaRows.read(row);
    }

    @Override
    protected <T> RowMapper<T> getSingleColumnRowMapper(Class<T> requiredType) {
        if (requiredType == java.sql.Timestamp.class) {
            return (row, index) -> requiredType.cast(ManagedSchemaTime.timestamp(row, 1));
        }
        return super.getSingleColumnRowMapper(requiredType);
    }

    @Override
    protected PreparedStatementSetter newArgPreparedStatementSetter(Object[] arguments) {
        return new ArgumentPreparedStatementSetter(arguments) {
            private ParameterMetaData parameters;
            private Boolean h2;

            @Override
            protected void doSetValue(PreparedStatement statement, int index, Object value)
                    throws SQLException {
                if (value instanceof java.sql.Timestamp timestamp) {
                    super.doSetValue(statement, index, timestamp.getTime());
                    return;
                }
                if (value instanceof String text) {
                    byte[] utf8 = ManagedSchemaKeys.identity(text);
                    if (h2 == null) {
                        h2 =
                                "H2"
                                        .equals(
                                                statement
                                                        .getConnection()
                                                        .getMetaData()
                                                        .getDatabaseProductName());
                    }
                    // H2 does not implement MySQL's contextual string-to-binary coercion.
                    if (h2) {
                        if (parameters == null) {
                            parameters = statement.getParameterMetaData();
                        }
                        int type = parameters.getParameterType(index);
                        if (type == Types.BINARY
                                || type == Types.VARBINARY
                                || type == Types.LONGVARBINARY) {
                            super.doSetValue(statement, index, utf8);
                            return;
                        }
                    }
                }
                super.doSetValue(statement, index, value);
            }
        };
    }
}
