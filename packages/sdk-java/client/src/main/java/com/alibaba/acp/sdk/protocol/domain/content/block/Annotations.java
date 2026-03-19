package com.alibaba.acp.sdk.protocol.domain.content.block;

import java.util.List;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

public class Annotations extends Meta {
    private List<Role> audience;
    private Double priority;
    private String lastModified;

    // Getters and setters
    public List<Role> getAudience() {
        return audience;
    }

    public void setAudience(List<Role> audience) {
        this.audience = audience;
    }

    public Double getPriority() {
        return priority;
    }

    public void setPriority(Double priority) {
        this.priority = priority;
    }

    public String getLastModified() {
        return lastModified;
    }

    public void setLastModified(String lastModified) {
        this.lastModified = lastModified;
    }

    // Inner class for Role
    public static class Role {
        private String role;

        public Role(String role) {
            this.role = role;
        }

        public String getRole() {
            return role;
        }

        public void setRole(String role) {
            this.role = role;
        }
    }
}
