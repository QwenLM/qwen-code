package com.alibaba.qwen.code.managedagent.api;

import java.util.EnumSet;
import java.util.Set;

/**
 * The versioned surface registry (design D5, issue #13535 R2): one constant
 * per implemented route of this server — every public ({@code /v1/agents}),
 * WebShell ({@code /api/agent/web-shell/v1}) and internal ({@code /internal})
 * handler method of the module's controllers, with the route's capability and
 * the admission rule class that answers for it today. The Spring-mounted
 * handler set is kept in exact bijection with these constants by
 * {@code SurfaceRegistryGateTest}, and today's per-route admission is pinned
 * by {@code SurfaceAdmissionAcceptanceTest}; rule flips towards the actor
 * roles land with contract v1.34 in slice C and change this file with them.
 *
 * <p>Rule classes name today's admission as implemented, after the design's
 * D5 vocabulary. Where a route's behaviour splits by Session kind (bound vs
 * legacy), the registered class is the bound-Session class and the class
 * documents the legacy fallback. The design's {@code legacy_create} and
 * {@code legacy_tenant} names are kept here as the documented names of those
 * legacy arms rather than as separate classes, because a route carries
 * exactly one rule class.
 */
public enum SurfaceRegistry {
    // PublicAgentController: public Session surfaces.
    PUBLIC_SESSION_CREATE(Method.POST, "/v1/agents/sessions",
            Surface.PUBLIC, RuleClass.WORKSPACE_CREATE,
            EnumSet.of(Capability.SESSION_CREATE)),
    PUBLIC_SESSION_LIST(Method.GET, "/v1/agents/sessions",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.SESSION_LIST)),
    PUBLIC_SESSION_GET(Method.GET, "/v1/agents/sessions/{sessionId}",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.SESSION_GET)),
    PUBLIC_SESSION_RENAME(Method.PATCH, "/v1/agents/sessions/{sessionId}",
            Surface.PUBLIC, RuleClass.OPERATOR,
            EnumSet.of(Capability.SESSION_RENAME)),
    PUBLIC_SESSION_CLOSE(Method.POST,
            "/v1/agents/sessions/{sessionId}/close",
            Surface.PUBLIC, RuleClass.OWNER,
            EnumSet.of(Capability.SESSION_CLOSE)),
    PUBLIC_SESSION_ARCHIVE(Method.POST,
            "/v1/agents/sessions/{sessionId}/archive",
            Surface.PUBLIC, RuleClass.OWNER,
            EnumSet.of(Capability.SESSION_ARCHIVE)),
    PUBLIC_SESSION_UNARCHIVE(Method.POST,
            "/v1/agents/sessions/{sessionId}/unarchive",
            Surface.PUBLIC, RuleClass.OWNER,
            EnumSet.of(Capability.SESSION_UNARCHIVE)),
    PUBLIC_SESSION_DELETE(Method.DELETE, "/v1/agents/sessions/{sessionId}",
            Surface.PUBLIC, RuleClass.OWNER,
            EnumSet.of(Capability.SESSION_DELETE)),
    PUBLIC_OPERATION_GET(Method.GET,
            "/v1/agents/sessions/{sessionId}/operations/{operationId}",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.SESSION_OPERATION_GET)),
    PUBLIC_CWD_CHANGE(Method.POST, "/v1/agents/sessions/{sessionId}/cwd",
            Surface.PUBLIC, RuleClass.OWNER,
            EnumSet.of(Capability.SESSION_CWD_CHANGE)),
    PUBLIC_TURN_EVENTS(Method.POST, "/v1/agents/sessions/{sessionId}/events",
            Surface.PUBLIC, RuleClass.OPERATOR,
            EnumSet.of(Capability.TURN_SUBMIT, Capability.TURN_CANCEL)),
    PUBLIC_EVENT_LIST(Method.GET, "/v1/agents/sessions/{sessionId}/events",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.TAIL_EVENTS)),
    PUBLIC_ITEM_LIST(Method.GET, "/v1/agents/sessions/{sessionId}/items",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.ITEM_LIST)),
    PUBLIC_TURN_LIST(Method.GET, "/v1/agents/sessions/{sessionId}/turns",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.TURN_LIST)),
    PUBLIC_TURN_GET(Method.GET,
            "/v1/agents/sessions/{sessionId}/turns/{turnId}",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.TURN_GET)),
    PUBLIC_TASK_LIST(Method.GET, "/v1/agents/sessions/{sessionId}/tasks",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.TASK_LIST)),
    PUBLIC_TASK_GET(Method.GET,
            "/v1/agents/sessions/{sessionId}/tasks/{taskId}",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.TASK_GET)),
    PUBLIC_TASK_EVENT_LIST(Method.GET,
            "/v1/agents/sessions/{sessionId}/tasks/{taskId}/events",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.TASK_EVENT_LIST)),
    // ManagedActionController: Action read and respond routes.
    PUBLIC_ACTION_LIST(Method.GET,
            "/v1/agents/sessions/{sessionId}/actions",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.ACTION_LIST)),
    PUBLIC_ACTION_GET(Method.GET,
            "/v1/agents/sessions/{sessionId}/actions/{actionId}",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.ACTION_GET)),
    PUBLIC_ACTION_RESPOND(Method.POST,
            "/v1/agents/sessions/{sessionId}/actions/{actionId}/responses",
            Surface.PUBLIC, RuleClass.OWNER,
            EnumSet.of(Capability.ACTION_RESPOND)),
    // ManagedArtifactController: tool-result and artifact routes.
    PUBLIC_TOOL_RESULT_GET(Method.GET,
            "/v1/agents/sessions/{sessionId}/items/{itemId}/tool-result",
            Surface.PUBLIC, RuleClass.READER_ACTOR,
            EnumSet.of(Capability.TOOL_RESULT_GET)),
    PUBLIC_ARTIFACT_LIST(Method.GET,
            "/v1/agents/sessions/{sessionId}/artifacts",
            Surface.PUBLIC, RuleClass.READER_ACTOR,
            EnumSet.of(Capability.ARTIFACT_LIST)),
    PUBLIC_ARTIFACT_GET(Method.GET,
            "/v1/agents/sessions/{sessionId}/artifacts/{artifactId}",
            Surface.PUBLIC, RuleClass.READER_ACTOR,
            EnumSet.of(Capability.ARTIFACT_GET)),
    PUBLIC_ARTIFACT_CONTENT(Method.GET,
            "/v1/agents/sessions/{sessionId}/artifacts/{artifactId}/content",
            Surface.PUBLIC, RuleClass.READER_ACTOR_POLICY,
            EnumSet.of(Capability.ARTIFACT_CONTENT)),
    // ManagedHookController and ManagedMcpController: Session catalogs.
    PUBLIC_HOOK_CATALOG(Method.GET,
            "/v1/agents/sessions/{sessionId}/hook-catalog",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.HOOK_CATALOG)),
    PUBLIC_MCP_CATALOG(Method.GET,
            "/v1/agents/sessions/{sessionId}/mcp-catalog",
            Surface.PUBLIC, RuleClass.READER,
            EnumSet.of(Capability.MCP_CATALOG)),
    // WorkspaceDiscoveryController: Workspace discovery routes.
    PUBLIC_WORKSPACE_LIST(Method.GET, "/v1/agents/workspaces",
            Surface.PUBLIC, RuleClass.WORKSPACE_DISCOVERY,
            EnumSet.of(Capability.WORKSPACE_LIST)),
    PUBLIC_WORKSPACE_GET(Method.GET, "/v1/agents/workspaces/{workspaceId}",
            Surface.PUBLIC, RuleClass.WORKSPACE_DISCOVERY,
            EnumSet.of(Capability.WORKSPACE_GET)),
    // AgentDefinitionController: tenant-scoped agent definition routes.
    PUBLIC_AGENT_DEFINITION_CREATE(Method.POST, "/v1/agents",
            Surface.PUBLIC, RuleClass.TENANT_SCOPED,
            EnumSet.of(Capability.AGENT_DEFINITION_CREATE)),
    PUBLIC_AGENT_DEFINITION_GET(Method.GET, "/v1/agents/{agentId}",
            Surface.PUBLIC, RuleClass.TENANT_SCOPED,
            EnumSet.of(Capability.AGENT_DEFINITION_GET)),
    PUBLIC_AGENT_DEFINITION_UPDATE(Method.POST, "/v1/agents/{agentId}",
            Surface.PUBLIC, RuleClass.TENANT_SCOPED,
            EnumSet.of(Capability.AGENT_DEFINITION_UPDATE)),
    // WebShellAgentController: WebShell Session surfaces.
    WEBSHELL_TASK_LIST(Method.POST, "/api/agent/web-shell/v1/tasks/query",
            Surface.WEBSHELL, RuleClass.READER,
            EnumSet.of(Capability.TASK_LIST)),
    WEBSHELL_TASK_GET(Method.POST, "/api/agent/web-shell/v1/tasks/get",
            Surface.WEBSHELL, RuleClass.READER,
            EnumSet.of(Capability.TASK_GET)),
    WEBSHELL_TASK_EVENT_LIST(Method.POST,
            "/api/agent/web-shell/v1/tasks/events/query",
            Surface.WEBSHELL, RuleClass.READER,
            EnumSet.of(Capability.TASK_EVENT_LIST)),
    WEBSHELL_SESSION_LIST(Method.POST, "/api/agent/web-shell/v1/sessions/query",
            Surface.WEBSHELL, RuleClass.READER,
            EnumSet.of(Capability.SESSION_LIST)),
    WEBSHELL_SESSION_GET(Method.POST, "/api/agent/web-shell/v1/sessions/get",
            Surface.WEBSHELL, RuleClass.READER,
            EnumSet.of(Capability.SESSION_GET)),
    WEBSHELL_TRANSCRIPT(Method.POST,
            "/api/agent/web-shell/v1/transcript/query",
            Surface.WEBSHELL, RuleClass.READER,
            EnumSet.of(Capability.TRANSCRIPT_QUERY)),
    WEBSHELL_EVENT_STREAM(Method.POST, "/api/agent/web-shell/v1/events/stream",
            Surface.WEBSHELL, RuleClass.READER,
            EnumSet.of(Capability.TAIL_EVENTS)),
    WEBSHELL_SESSION_CREATE(Method.POST,
            "/api/agent/web-shell/v1/sessions/create",
            Surface.WEBSHELL, RuleClass.WORKSPACE_CREATE,
            EnumSet.of(Capability.SESSION_CREATE)),
    WEBSHELL_TURN_SUBMIT(Method.POST, "/api/agent/web-shell/v1/turns/submit",
            Surface.WEBSHELL, RuleClass.OPERATOR,
            EnumSet.of(Capability.TURN_SUBMIT)),
    WEBSHELL_TURN_CANCEL(Method.POST, "/api/agent/web-shell/v1/turns/cancel",
            Surface.WEBSHELL, RuleClass.OPERATOR,
            EnumSet.of(Capability.TURN_CANCEL)),
    WEBSHELL_SESSION_CLOSE(Method.POST, "/api/agent/web-shell/v1/sessions/close",
            Surface.WEBSHELL, RuleClass.OWNER,
            EnumSet.of(Capability.SESSION_CLOSE)),
    WEBSHELL_SESSION_ARCHIVE(Method.POST,
            "/api/agent/web-shell/v1/sessions/archive",
            Surface.WEBSHELL, RuleClass.OWNER,
            EnumSet.of(Capability.SESSION_ARCHIVE)),
    WEBSHELL_SESSION_DELETE(Method.POST,
            "/api/agent/web-shell/v1/sessions/delete",
            Surface.WEBSHELL, RuleClass.OWNER,
            EnumSet.of(Capability.SESSION_DELETE)),
    WEBSHELL_SESSION_UNARCHIVE(Method.POST,
            "/api/agent/web-shell/v1/sessions/unarchive",
            Surface.WEBSHELL, RuleClass.OWNER,
            EnumSet.of(Capability.SESSION_UNARCHIVE)),
    WEBSHELL_OPERATION_GET(Method.POST,
            "/api/agent/web-shell/v1/operations/query",
            Surface.WEBSHELL, RuleClass.READER,
            EnumSet.of(Capability.SESSION_OPERATION_GET)),
    WEBSHELL_CWD_CHANGE(Method.POST,
            "/api/agent/web-shell/v1/sessions/cwd/change",
            Surface.WEBSHELL, RuleClass.OWNER,
            EnumSet.of(Capability.SESSION_CWD_CHANGE)),
    WEBSHELL_ACTION_LIST(Method.POST, "/api/agent/web-shell/v1/actions/query",
            Surface.WEBSHELL, RuleClass.READER,
            EnumSet.of(Capability.ACTION_LIST)),
    WEBSHELL_ACTION_GET(Method.POST, "/api/agent/web-shell/v1/actions/get",
            Surface.WEBSHELL, RuleClass.READER,
            EnumSet.of(Capability.ACTION_GET)),
    WEBSHELL_ACTION_RESPOND(Method.POST,
            "/api/agent/web-shell/v1/actions/respond",
            Surface.WEBSHELL, RuleClass.OWNER,
            EnumSet.of(Capability.ACTION_RESPOND)),
    WEBSHELL_TOOL_RESULT_GET(Method.POST,
            "/api/agent/web-shell/v1/tool-results/get",
            Surface.WEBSHELL, RuleClass.READER_ACTOR,
            EnumSet.of(Capability.TOOL_RESULT_GET)),
    WEBSHELL_ARTIFACT_GET(Method.POST, "/api/agent/web-shell/v1/artifacts/get",
            Surface.WEBSHELL, RuleClass.READER_ACTOR,
            EnumSet.of(Capability.ARTIFACT_GET)),
    WEBSHELL_ARTIFACT_LIST(Method.POST,
            "/api/agent/web-shell/v1/artifacts/query",
            Surface.WEBSHELL, RuleClass.READER_ACTOR,
            EnumSet.of(Capability.ARTIFACT_LIST)),
    WEBSHELL_WORKSPACE_LIST(Method.POST,
            "/api/agent/web-shell/v1/workspaces/query",
            Surface.WEBSHELL, RuleClass.WORKSPACE_DISCOVERY,
            EnumSet.of(Capability.WORKSPACE_LIST)),
    WEBSHELL_WORKSPACE_GET(Method.POST,
            "/api/agent/web-shell/v1/workspaces/get",
            Surface.WEBSHELL, RuleClass.WORKSPACE_DISCOVERY,
            EnumSet.of(Capability.WORKSPACE_GET)),
    // ManagedSessionStoreController: internal writer routes.
    INTERNAL_EXECUTION_AUTHORIZE(Method.POST,
            "/internal/managed-session-store/v1/sessions/{sessionId}"
                    + "/execution:authorize",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.STORE_EXECUTION_AUTHORIZE)),
    INTERNAL_LIFECYCLE_AUTHORIZE(Method.POST,
            "/internal/managed-session-store/v1/sessions/{sessionId}"
                    + "/lifecycle:authorize",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.STORE_LIFECYCLE_AUTHORIZE)),
    INTERNAL_WRITER_ACQUIRE(Method.POST,
            "/internal/managed-session-store/v1/sessions/{sessionId}"
                    + "/writers:acquire",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.STORE_WRITER_ACQUIRE)),
    INTERNAL_WRITER_RENEW(Method.POST,
            "/internal/managed-session-store/v1/sessions/{sessionId}"
                    + "/writers:renew",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.STORE_WRITER_RENEW)),
    INTERNAL_WRITER_SEAL(Method.POST,
            "/internal/managed-session-store/v1/sessions/{sessionId}"
                    + "/writers:seal",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.STORE_WRITER_SEAL)),
    INTERNAL_RECOVERY_BLOCK(Method.POST,
            "/internal/managed-session-store/v1/sessions/{sessionId}"
                    + "/recovery:block",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.STORE_RECOVERY_BLOCK)),
    INTERNAL_TRANSACTION_COMMIT(Method.POST,
            "/internal/managed-session-store/v1/sessions/{sessionId}"
                    + "/transactions:commit",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.STORE_TRANSACTION_COMMIT)),
    INTERNAL_RESTORE(Method.GET,
            "/internal/managed-session-store/v1/sessions/{sessionId}/restore",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.STORE_RESTORE)),
    INTERNAL_TOOL_RESULT_PUBLISH(Method.POST,
            "/internal/managed-session-store/v1/sessions/{sessionId}"
                    + "/tool-results:publish",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.STORE_TOOL_RESULT_PUBLISH)),
    INTERNAL_TRANSACTION_LIST(Method.GET,
            "/internal/managed-session-store/v1/sessions/{sessionId}"
                    + "/transactions",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.STORE_TRANSACTION_LIST)),
    INTERNAL_RESOURCE_GET(Method.GET,
            "/internal/managed-session-store/v1/sessions/{sessionId}"
                    + "/resources/{resourceId}",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.STORE_RESOURCE_GET)),
    // ToolPublicationController: internal publication routes.
    INTERNAL_PUB_GRANT(Method.POST,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/grants",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_GRANT)),
    INTERNAL_PUB_SEGMENT(Method.POST,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/publications/{publicationId}/segments"
                    + "/{streamId}/{ordinal}",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_SEGMENT)),
    INTERNAL_PUB_RESOURCE(Method.POST,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/publications/{publicationId}/resources/{kind}/{slot}",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_RESOURCE)),
    INTERNAL_PUB_STREAM_SEAL(Method.POST,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/publications/{publicationId}/streams/{streamId}/seal",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_STREAM_SEAL)),
    INTERNAL_PUB_STREAM_PREFIX(Method.POST,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/publications/{publicationId}/streams/{streamId}"
                    + "/prefix",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_STREAM_PREFIX)),
    INTERNAL_PUB_FINISH(Method.POST,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/publications/{publicationId}/finish",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_FINISH)),
    INTERNAL_PUB_OPERATION_GET(Method.GET,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/publications/{publicationId}/operations"
                    + "/{operationId}",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_OPERATION_GET)),
    INTERNAL_PUB_OPERATION_RECOVER(Method.POST,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/publications/{publicationId}/operations"
                    + "/{operationId}/recover",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_OPERATION_RECOVER)),
    INTERNAL_PUB_FINISHED(Method.GET,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/publications/{publicationId}/finished",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_FINISHED)),
    INTERNAL_PUB_ADMISSION_PREPARE(Method.POST,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/publications/{publicationId}/admissions/prepare",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_ADMISSION_PREPARE)),
    INTERNAL_PUB_RECEIPT_VERIFY(Method.POST,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/receipts/verify",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_RECEIPT_VERIFY)),
    INTERNAL_PUB_RECEIPT_COMMIT(Method.POST,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/publications/{publicationId}/receipts/commit",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_RECEIPT_COMMIT)),
    INTERNAL_PUB_RANGE(Method.POST,
            "/internal/managed-tool-publications/v1/sessions/{sessionId}"
                    + "/publications/{publicationId}/range",
            Surface.INTERNAL, RuleClass.INTERNAL_WRITER,
            EnumSet.of(Capability.PUB_RANGE));

    private final String method;
    private final String template;
    private final Surface surface;
    private final RuleClass ruleClass;
    private final Set<Capability> capabilities;

    SurfaceRegistry(Method method, String template, Surface surface,
            RuleClass ruleClass, Set<Capability> capabilities) {
        this.method = method.value;
        this.template = template;
        this.surface = surface;
        this.ruleClass = ruleClass;
        // unmodifiableSet keeps the declaration order; Set.copyOf does not
        // (the dual-purpose events route relies on TURN_SUBMIT first).
        this.capabilities =
                java.util.Collections.unmodifiableSet(capabilities);
    }

    /** The HTTP method of the route, as the mapping declares it. */
    public String method() {
        return method;
    }

    /** The full path template, spelled as on the controller mapping. */
    public String template() {
        return template;
    }

    public Surface surface() {
        return surface;
    }

    public RuleClass ruleClass() {
        return ruleClass;
    }

    /** One or more capabilities; a dual-purpose route carries its set. */
    public Set<Capability> capabilities() {
        return capabilities;
    }

    /** The route key the gate matches against Spring handler mappings. */
    public String routeKey() {
        return method + " " + template;
    }

    /** HTTP methods as the mapping annotations declare them. */
    private enum Method {
        GET("GET"), POST("POST"), PATCH("PATCH"), DELETE("DELETE");

        private final String value;

        Method(String value) {
            this.value = value;
        }
    }

    /** The surface a route is served on. */
    public enum Surface {
        /** The public surface ({@code /v1/agents/**}). */
        PUBLIC,
        /** The WebShell surface ({@code /api/agent/web-shell/v1/**}). */
        WEBSHELL,
        /** The internal writer surface ({@code /internal/**}). */
        INTERNAL
    }

    /**
     * A capability id: the admission-stable unit a route belongs to. The
     * public and WebShell twins of one capability share its id; the
     * dual-purpose {@code POST /v1/agents/sessions/{sessionId}/events} route
     * carries both {@link #TURN_SUBMIT} and {@link #TURN_CANCEL}.
     */
    public enum Capability {
        SESSION_CREATE,
        SESSION_LIST,
        SESSION_GET,
        SESSION_RENAME,
        SESSION_CLOSE,
        SESSION_ARCHIVE,
        SESSION_UNARCHIVE,
        SESSION_DELETE,
        SESSION_OPERATION_GET,
        SESSION_CWD_CHANGE,
        TURN_SUBMIT,
        TURN_CANCEL,
        TAIL_EVENTS,
        ITEM_LIST,
        TURN_LIST,
        TURN_GET,
        TASK_LIST,
        TASK_GET,
        TASK_EVENT_LIST,
        TRANSCRIPT_QUERY,
        ACTION_LIST,
        ACTION_GET,
        ACTION_RESPOND,
        HOOK_CATALOG,
        MCP_CATALOG,
        TOOL_RESULT_GET,
        ARTIFACT_LIST,
        ARTIFACT_GET,
        ARTIFACT_CONTENT,
        WORKSPACE_LIST,
        WORKSPACE_GET,
        AGENT_DEFINITION_CREATE,
        AGENT_DEFINITION_GET,
        AGENT_DEFINITION_UPDATE,
        STORE_EXECUTION_AUTHORIZE,
        STORE_LIFECYCLE_AUTHORIZE,
        STORE_WRITER_ACQUIRE,
        STORE_WRITER_RENEW,
        STORE_WRITER_SEAL,
        STORE_RECOVERY_BLOCK,
        STORE_TRANSACTION_COMMIT,
        STORE_RESTORE,
        STORE_TOOL_RESULT_PUBLISH,
        STORE_TRANSACTION_LIST,
        STORE_RESOURCE_GET,
        PUB_GRANT,
        PUB_SEGMENT,
        PUB_RESOURCE,
        PUB_STREAM_SEAL,
        PUB_STREAM_PREFIX,
        PUB_FINISH,
        PUB_OPERATION_GET,
        PUB_OPERATION_RECOVER,
        PUB_FINISHED,
        PUB_ADMISSION_PREPARE,
        PUB_RECEIPT_VERIFY,
        PUB_RECEIPT_COMMIT,
        PUB_RANGE
    }

    /**
     * The admission rule class a route follows today. Each class names
     * today's rule as implemented and states its slice-C destination; the
     * acceptance suite walks these classes to build its probe matrix.
     */
    public enum RuleClass {
        /**
         * Bound-Session creation: a trusted actor ({@code 401
         * actor_required} without one) holding {@code can_read} ({@code 404
         * workspace_not_found} below) and {@code can_create} ({@code 403
         * workspace_forbidden} below) on an {@code ACTIVE} Workspace ({@code
         * 409 workspace_unavailable} otherwise) is admitted. The legacy arm
         * — the same route with no Workspace selection, the design's
         * {@code legacy_create} — admits any tenant caller, actor or not.
         */
        WORKSPACE_CREATE,
        /**
         * Reads of a Session and its records (events, items, turns, tasks,
         * Actions and catalogs, JSON and SSE): the caller needs
         * {@code can_read} on the bound Workspace and gets {@code 404
         * session_not_found} below it — this class holds the {@code
         * 404-below-read} contract of #12867. The two Session lists carry
         * the same predicate as a filter: they answer any tenant caller
         * with the rows that caller may read. The legacy arm (the design's
         * {@code legacy_tenant}) admits every tenant caller.
         */
        READER,
        /**
         * Tool-result and artifact metadata routes: like {@link #READER},
         * but the route requires a trusted actor even on the legacy arm
         * ({@code 401 actor_required} without one) and answers {@code 404
         * artifact_not_found} when the Session is not a live bound one or
         * the deployment's artifact reads are off.
         */
        READER_ACTOR,
        /**
         * Artifact byte reads: {@link #READER_ACTOR} plus the deployment
         * content policy — with the policy off the readable actor gets
         * {@code 403 artifact_content_forbidden}.
         */
        READER_ACTOR_POLICY,
        /**
         * Today's submitter family (D4's OPERATOR destination): Turn
         * submit, Turn cancel and rename admit only the Session's creator
         * while the creator still holds {@code can_create}, and refuse a
         * readable non-creator with {@code 409 workspace_unavailable}
         * (slice C normalises the refusal to {@code 403
         * session_operation_forbidden}). The legacy arm is tenant-wide.
         */
        OPERATOR,
        /**
         * Today's creator families whose slice-C destinations differ:
         * lifecycle (close, archive, unarchive, delete — D4's OWNER),
         * cwd change (D4's OPERATOR) and Action respond (D4's OPERATOR,
         * same class here because the current code admits the recorded
         * creator for all three). Below the Workspace read grant: {@code
         * 404}; a readable non-creator gets {@code 403
         * session_operation_forbidden} on lifecycle and cwd, {@code 403
         * action_forbidden} on respond; cwd also requires a workspace-bound
         * Session and a trusted actor. The legacy arm of lifecycle and
         * respond is tenant-wide (respond additionally requires a recorded
         * creator or create command).
         */
        OWNER,
        /**
         * Workspace discovery lists and reads: a trusted actor is required
         * ({@code 401 actor_required} without one) and the answers are
         * filtered to the caller's {@code can_read} Workspaces, so an
         * ungranted Workspace is invisible.
         */
        WORKSPACE_DISCOVERY,
        /**
         * Tenant-scoped agent definitions: any caller of the tenant may
         * create, read and revise; no actor and no Workspace grant is
         * involved today.
         */
        TENANT_SCOPED,
        /**
         * Internal Session-store and tool-publication routes: no actor at
         * all; the writer HMAC credential issued for the Session scope
         * answers a wrong token {@code 403
         * writer_credential_invalid}, and on a dedicated internal
         * listener the routing filter answers a public-connector caller
         * {@code 404}.
         */
        INTERNAL_WRITER
    }
}
