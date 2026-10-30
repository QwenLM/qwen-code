package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CsiRuntimeMarkerProbeTest {
    /**
     * The marker probe runs on every ordinary writer admission. Its plain
     * reads still wait on metadata locks, so both carry the guard class's
     * statement timeout instead of the server's year-long default; neither
     * may take the fence's {@code FOR UPDATE} range locks.
     */
    @Test
    void bothMarkerReadsAreLockFreeAndCarryTheQueryTimeout() throws Exception {
        var connection = mock(Connection.class);
        var statement = mock(PreparedStatement.class);
        var rows = mock(ResultSet.class);
        when(connection.prepareStatement(anyString())).thenReturn(statement);
        when(statement.executeQuery()).thenReturn(rows);

        assertThat(JdbcCsiFilesRetirementGuard.hasCsiRuntimeMarker(connection, "tenant", "session")).isFalse();

        var sql = ArgumentCaptor.forClass(String.class);
        verify(connection, times(2)).prepareStatement(sql.capture());
        verify(statement, times(2)).setQueryTimeout(10);
        assertThat(sql.getAllValues()).allSatisfy(text -> assertThat(text).doesNotContain("FOR UPDATE"));
        assertThat(sql.getAllValues()).anySatisfy(text -> assertThat(text)
                .startsWith("SELECT " + ManagedSchemaProjection.RUNTIME_SLOT.columns()
                        + " FROM ma_runtime_slot"));
        assertThat(sql.getAllValues()).anySatisfy(text -> assertThat(text)
                .startsWith("SELECT " + ManagedSchemaProjection.RUNTIME_BINDING.columns()
                        + " FROM ma_runtime_binding"));
    }

    /**
     * The fence keeps the range locks the probe must not take: dropping either
     * suffix, or running a locking call site with the probe's flag, would let a
     * concurrent {@code findOrCreate} insert a second slot/binding between this
     * read and {@code requireOriginal}'s size check.
     */
    @Test
    void fenceStillTakesTheForUpdateRangeLocks() throws Exception {
        var connection = mock(Connection.class);
        var placement = mock(ResultSet.class);
        when(connection.getAutoCommit()).thenReturn(false);
        when(placement.next()).thenReturn(true, false);
        when(placement.getString("tenant_id")).thenReturn("tenant");
        when(connection.prepareStatement(anyString())).thenAnswer(call -> {
            var prepared = mock(PreparedStatement.class);
            when(prepared.executeQuery()).thenReturn(call.<String>getArgument(0).contains("runtime_placement")
                    ? placement
                    : mock(ResultSet.class));
            return prepared;
        });

        assertThat(JdbcCsiFilesRetirementGuard.lockManagedSession(connection, "tenant", "session")).isNull();

        var sql = ArgumentCaptor.forClass(String.class);
        verify(connection, atLeastOnce()).prepareStatement(sql.capture());
        assertThat(sql.getAllValues().stream()
                .filter(text -> text.contains(" FROM ma_runtime_slot ")
                        || text.contains(" FROM ma_runtime_binding ")).toList())
                .hasSize(2)
                .allSatisfy(text -> assertThat(text).contains("FOR UPDATE"));
    }
}
