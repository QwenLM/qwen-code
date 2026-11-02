package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.SessionModelConfig;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.security.ProtectedSecret;
import com.alibaba.qwen.code.runtimebroker.security.SecretProtector;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class ManagedSessionModelConfigs {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final ObjectProvider<SecretProtector> secrets;
    private final ManagedAgentSettings settings;

    public ManagedSessionModelConfigs(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json,
            ObjectProvider<SecretProtector> secrets, ManagedAgentSettings settings) {
        this.jdbc = jdbc;
        this.json = json;
        this.secrets = secrets;
        this.settings = settings;
    }

    public void requireAdmission(SessionModelConfig config) {
        if (!settings.getSessionStore().isEnabled() || secrets.getIfAvailable() == null) {
            throw unavailable();
        }
        if (!settings.getModelConfigBaseUrls().contains(config.baseUrl())) {
            throw new ManagedAgentException(400, "model_endpoint_not_allowed", "The model endpoint is not permitted.");
        }
    }

    public void save(String tenant, String session, SessionModelConfig config) {
        try {
            SecretProtector protector = secrets.getIfAvailable();
            if (protector == null) {
                throw unavailable();
            }
            ProtectedSecret encrypted = protector.protect(context(tenant, session), json.writeValueAsBytes(config.wireValue()));
            if (jdbc.update("UPDATE ma_session SET model_config_digest=?, model_config_key_id=?, model_config_ciphertext=?"
                    + " WHERE tenant_id=? AND session_id=? AND model_config_digest IS NULL",
                    config.digest(), encrypted.getKeyId(), encrypted.getCiphertext(), tenant, session) != 1) {
                throw unavailable();
            }
        } catch (JsonProcessingException error) {
            throw unavailable();
        }
    }

    public String digest(String tenant, String session) {
        var values = jdbc.query("SELECT model_config_digest FROM ma_session WHERE tenant_id=? AND session_id=?",
                (row, index) -> row.getString(1), tenant, session);
        return values.isEmpty() ? null : values.getFirst();
    }

    public SessionModelConfig read(String tenant, String session, String expectedDigest) {
        var values = jdbc.query("SELECT model_config_digest, model_config_key_id, model_config_ciphertext"
                + " FROM ma_session WHERE tenant_id=? AND session_id=?", (row, index) -> {
                    if (expectedDigest == null || !expectedDigest.equals(row.getString(1))) {
                        throw unavailable();
                    }
                    SecretProtector protector = secrets.getIfAvailable();
                    if (protector == null) {
                        throw unavailable();
                    }
                    byte[] bytes = protector.unprotect(context(tenant, session),
                            new ProtectedSecret(row.getString(2), row.getString(3)));
                    try {
                        SessionModelConfig config = SessionModelConfig.parse(json.readTree(bytes));
                        if (config == null || !expectedDigest.equals(config.digest())) {
                            throw unavailable();
                        }
                        return config;
                    } catch (java.io.IOException error) {
                        throw unavailable();
                    }
                }, tenant, session);
        if (values.size() != 1) {
            throw unavailable();
        }
        return values.getFirst();
    }

    public void inherit(String tenant, String parent, String child) {
        String digest = digest(tenant, parent);
        if (digest != null) {
            save(tenant, child, read(tenant, parent, digest));
        }
    }

    private static String context(String tenant, String session) {
        return "managed-session-model-config/1:" + ManagedSchemaKeys.key(tenant, session);
    }

    private static ManagedAgentException unavailable() {
        return new ManagedAgentException(409, "model_config_unavailable", "The Session model configuration is unavailable.");
    }
}
