package com.alibaba.acp.sdk.protocol.agent.request.terminal;

import java.util.List;

import com.alibaba.acp.sdk.protocol.domain.terminal.EnvVariable;
import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.agent.request.terminal.CreateTerminalRequest.CreateTerminalRequestParams;

@JSONType(typeName = "terminal/create")
public class CreateTerminalRequest extends Request<CreateTerminalRequestParams> {
    public CreateTerminalRequest() {
        this(new CreateTerminalRequestParams());
    }

    public CreateTerminalRequest(CreateTerminalRequestParams requestParams) {
        super("terminal/create", requestParams);
    }

    public static class CreateTerminalRequestParams extends Meta {
        private String sessionId;
        private String command;
        private List<String> args;
        private String cwd;
        private List<EnvVariable> env;
        private Long outputByteLimit;

        // Getters and setters
        public String getSessionId() {
            return sessionId;
        }

        public void setSessionId(String sessionId) {
            this.sessionId = sessionId;
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

        public String getCwd() {
            return cwd;
        }

        public void setCwd(String cwd) {
            this.cwd = cwd;
        }

        public List<EnvVariable> getEnv() {
            return env;
        }

        public void setEnv(List<EnvVariable> env) {
            this.env = env;
        }

        public Long getOutputByteLimit() {
            return outputByteLimit;
        }

        public void setOutputByteLimit(Long outputByteLimit) {
            this.outputByteLimit = outputByteLimit;
        }
    }
}
