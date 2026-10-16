package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CsiRuntimeMarkerProbeTest {
    /**
     * The marker probe runs on every ordinary writer admission. Its plain
     * reads still wait on metadata locks, so both carry the guard class's
     * statement timeout instead of the server's year-long default.
     */
    @Test
    void bothMarkerReadsCarryTheQueryTimeout() throws Exception {
        var connection = mock(Connection.class);
        var statement = mock(PreparedStatement.class);
        var rows = mock(ResultSet.class);
        when(connection.prepareStatement(anyString())).thenReturn(statement);
        when(statement.executeQuery()).thenReturn(rows);

        assertThat(JdbcCsiFilesRetirementGuard.hasCsiRuntimeMarker(connection, "tenant", "session")).isFalse();

        verify(connection, times(2)).prepareStatement(anyString());
        verify(statement, times(2)).setQueryTimeout(10);
    }
}
