package com.alibaba.acp.sdk.protocol.domain.mcp;

import java.util.List;

import com.alibaba.acp.sdk.protocol.domain.terminal.EnvVariable;
import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

public class McpServer extends Meta {
    private String type;
    private String name;
    private String command;
    private List<String> args;
    private List<EnvVariable> env;

    // Stdio-specific fields
    private List<HttpHeader> headers;
    private String url;

    // Getters and setters
    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getCommand() {
        return command;
    }

    public void setCommand(String command) {
        this.command = command;
    }

    public List<String> getArgs() {
        return args;
    }

    public void setArgs(List<String> args) {
        this.args = args;
    }

    public List<EnvVariable> getEnv() {
        return env;
    }

    public void setEnv(List<EnvVariable> env) {
        this.env = env;
    }

    public List<HttpHeader> getHeaders() {
        return headers;
    }

    public void setHeaders(List<HttpHeader> headers) {
        this.headers = headers;
    }

    public String getUrl() {
        return url;
    }

    public void setUrl(String url) {
        this.url = url;
    }
}
