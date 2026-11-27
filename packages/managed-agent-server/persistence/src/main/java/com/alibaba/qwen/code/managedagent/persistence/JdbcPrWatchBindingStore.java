package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.repository.PrWatchBindingStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

/** The PR-watch binding rows beside the channel indexes (V1 baseline). */
@Repository
public class JdbcPrWatchBindingStore implements PrWatchBindingStore {
    private static final RowMapper<PrWatchBinding> BINDING = (row, index) ->
            new PrWatchBinding(row.getString("tenant_id"),
                    row.getString("channel_id"), row.getString("binding_id"),
                    row.getString("owner"), row.getString("repo"),
                    row.getLong("pr_number"), row.getString("session_id"),
                    row.getString("events_json"), row.getLong("gmt_create"));

    private final JdbcTemplate jdbc;

    public JdbcPrWatchBindingStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public PrWatchBinding bind(PrWatchBinding candidate) {
        jdbc.update("INSERT IGNORE INTO ma_pr_watch_binding"
                        + " (tenant_id, channel_id, binding_id, owner, repo,"
                        + " pr_number, session_id, events_json, gmt_create)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                candidate.tenantId(), candidate.channelId(),
                candidate.bindingId(), candidate.owner(), candidate.repo(),
                candidate.prNumber(), candidate.sessionId(),
                candidate.eventsJson(), databaseNow());
        return findBinding(candidate.tenantId(), candidate.channelId(),
                candidate.owner(), candidate.repo(), candidate.prNumber())
                .orElseThrow();
    }

    @Override
    public Optional<PrWatchBinding> findBinding(String tenantId,
            String channelId, String owner, String repo, long prNumber) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.PR_WATCH_BINDING.columns()
                        + " FROM ma_pr_watch_binding WHERE tenant_id = ?"
                        + " AND channel_id = ? AND owner = ? AND repo = ?"
                        + " AND pr_number = ?",
                BINDING, tenantId, channelId, owner, repo, prNumber)
                .stream().findFirst();
    }

    @Override
    public List<PrWatchBinding> listByChannel(String tenantId,
            String channelId) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.PR_WATCH_BINDING.columns()
                        + " FROM ma_pr_watch_binding WHERE tenant_id = ?"
                        + " AND channel_id = ?"
                        + " ORDER BY gmt_create, binding_id",
                BINDING, tenantId, channelId);
    }

    @Override
    public boolean retire(String tenantId, String channelId, String owner,
            String repo, long prNumber) {
        return jdbc.update("DELETE FROM ma_pr_watch_binding"
                        + " WHERE tenant_id = ? AND channel_id = ?"
                        + " AND owner = ? AND repo = ? AND pr_number = ?",
                tenantId, channelId, owner, repo, prNumber) == 1;
    }

    private long databaseNow() {
        return jdbc.queryForObject(
                "SELECT UNIX_TIMESTAMP(),"
                        + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> Math.addExact(
                        Math.multiplyExact(row.getLong(1), 1000),
                        row.getLong(2) / 1000));
    }
}
