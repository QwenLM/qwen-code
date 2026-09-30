package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.service.ManagedArtifactPolicy;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ManagedArtifactConfiguration {
    @Bean
    @ConditionalOnMissingBean(ManagedArtifactPolicy.class)
    public ManagedArtifactPolicy managedArtifactPolicy(ManagedAgentProperties properties) {
        var settings = properties.getArtifacts();
        return new ManagedArtifactPolicy() {
            public String version() {
                return "o3-v1:" + settings.isEnabled() + ":" + settings.isPublishOriginal() + ":"
                        + settings.isPublishPreview();
            }

            public boolean publishOriginal(String tenantId, String workspaceId,
                    String sessionId) {
                return settings.isEnabled() && settings.isPublishOriginal();
            }

            public boolean publishPreview(String tenantId, String workspaceId,
                    String sessionId) {
                return publishOriginal(tenantId, workspaceId, sessionId)
                        && settings.isPublishPreview();
            }

            public boolean readOriginal(String tenantId, String actorId,
                    String workspaceId, String sessionId) {
                return actorId != null && !actorId.isBlank()
                        && publishOriginal(tenantId, workspaceId, sessionId);
            }
        };
    }
}
