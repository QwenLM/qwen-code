package db.migration;

import com.alibaba.qwen.code.managedagent.store.EventIdentity;
import com.alibaba.qwen.code.managedagent.store.EventIdentity.Identity;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.flywaydb.core.api.migration.BaseJavaMigration;
import org.flywaydb.core.api.migration.Context;

/**
 * Gives events written before V14 the Item and Part identity that the server
 * now assigns when it accepts an event. It applies the same
 * {@link EventIdentity} rule, one Session at a time in sequence order, so that
 * replayed events name the Items and Parts of the Snapshot.
 */
public class V15__managed_event_identity extends BaseJavaMigration {
    private static final TypeReference<Map<String, Object>> MAP_TYPE =
            new TypeReference<>() {
            };
    private static final int BATCH_SIZE = 500;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public void migrate(Context context) throws Exception {
        Connection connection = context.getConnection();
        List<String[]> sessions = new ArrayList<>();
        try (Statement statement = connection.createStatement();
                ResultSet rows = statement.executeQuery("SELECT DISTINCT"
                        + " tenant_id, session_id FROM managed_agent_event")) {
            while (rows.next()) {
                sessions.add(new String[] {rows.getString(1),
                        rows.getString(2)});
            }
        }
        try (PreparedStatement select = connection.prepareStatement("SELECT"
                        + " sequence_id, event_type, turn_id, CASE WHEN"
                        + " event_type IN ('turn.accepted',"
                        + " 'item.output_text.delta', 'item.reasoning.delta',"
                        + " 'item.tool_call.updated') THEN data_json END AS"
                        + " data_json FROM managed_agent_event WHERE"
                        + " tenant_id = ? AND session_id = ? ORDER BY"
                        + " sequence_id");
                PreparedStatement update = connection.prepareStatement(
                        "UPDATE managed_agent_event SET item_id = ?,"
                                + " content_part_id = ? WHERE tenant_id = ?"
                                + " AND session_id = ? AND sequence_id"
                                + " BETWEEN ? AND ?")) {
            for (String[] session : sessions) {
                backfill(select, update, session[0], session[1]);
            }
        }
    }

    // A text stream shares one identity across consecutive rows, so each run
    // of equal identities is one ranged update rather than one per row.
    private void backfill(PreparedStatement select, PreparedStatement update,
            String tenantId, String sessionId) throws Exception {
        select.setString(1, tenantId);
        select.setString(2, sessionId);
        update.setString(3, tenantId);
        update.setString(4, sessionId);
        int pending = 0;
        Identity run = null;
        long first = 0;
        long last = 0;
        try (ResultSet rows = select.executeQuery()) {
            Identity previous = null;
            long previousSequence = -1;
            while (rows.next()) {
                long sequence = rows.getLong("sequence_id");
                String data = rows.getString("data_json");
                Identity identity = EventIdentity.of(
                        rows.getString("event_type"),
                        rows.getString("turn_id"), sequence,
                        data == null ? Map.of()
                                : objectMapper.readValue(data, MAP_TYPE),
                        previousSequence == sequence - 1 ? previous : null);
                previous = identity;
                previousSequence = sequence;
                if (identity.itemId() == null) {
                    continue;
                }
                if (run != null && sequence == last + 1
                        && identity.itemId().equals(run.itemId())
                        && Objects.equals(identity.contentPartId(),
                                run.contentPartId())) {
                    last = sequence;
                    continue;
                }
                if (run != null) {
                    pending = add(update, run, first, last, pending);
                }
                run = identity;
                first = sequence;
                last = sequence;
            }
        }
        if (run != null) {
            pending = add(update, run, first, last, pending);
        }
        if (pending > 0) {
            execute(update);
        }
    }

    private static int add(PreparedStatement update, Identity identity,
            long first, long last, int pending) throws SQLException {
        update.setString(1, identity.itemId());
        update.setString(2, identity.contentPartId());
        update.setLong(5, first);
        update.setLong(6, last);
        update.addBatch();
        if (pending + 1 < BATCH_SIZE) {
            return pending + 1;
        }
        execute(update);
        return 0;
    }

    private static void execute(PreparedStatement update) throws SQLException {
        update.executeBatch();
        update.clearBatch();
    }
}
