FROM maven:3.9.11-eclipse-temurin-21 AS build

WORKDIR /workspace
COPY packages/sdk-java/qwencode packages/sdk-java/qwencode
COPY packages/managed-agent-server packages/managed-agent-server
COPY packages/core/src/managed-runtime/contracts/managed-tool-result-v1.schema.json packages/core/src/managed-runtime/contracts/

RUN mvn --batch-mode --no-transfer-progress \
      -f packages/sdk-java/qwencode/pom.xml \
      -DskipTests -Dgpg.skip=true install \
    && mvn --batch-mode --no-transfer-progress \
      -f packages/managed-agent-server/pom.xml \
      -DskipTests package \
    # The ordinary dependency jar is not executable. Select the exec
    # classifier without pinning the version and publish it under a fixed name;
    # fail the build (rather than ship a bad image) unless exactly one
    # exists. sh has no nullglob, so a zero-match glob yields the pattern
    # itself — break on it so the count check below still fails, and name
    # the expectation loudly instead of dying at cp.
    && cd packages/managed-agent-server/server/target \
    && main="" && count=0 \
    && for f in qwen-managed-agent-server-*-exec.jar; do \
         [ -e "$f" ] || break; \
         main="$f"; count=$((count+1)); \
       done \
    && { [ "$count" -eq 1 ] || { \
         echo >&2 "expected exactly one executable server jar," \
            "found $count"; exit 1; \
       }; } \
    && cp "$main" /tmp/qwen-managed-agent-server.jar

FROM eclipse-temurin:21-jre

WORKDIR /app
COPY --from=build /tmp/qwen-managed-agent-server.jar \
  /app/qwen-managed-agent-server.jar

# The image keeps the application.yml loopback defaults: under the shipped
# `auto` auth mode the server refuses a non-loopback bind, so a plain
# `docker run -p 8080:8080` must not — and cannot — publish it. Publishing
# is an explicit operator opt-in that names an authentication posture (see
# the README's container section):
#   docker run -p 8080:8080 \
#     -e QWEN_MANAGED_AGENT_SERVER_ADDRESS=0.0.0.0 \
#     -e QWEN_MANAGED_AGENT_AUTH_MODE=signed \
#     -e QWEN_MANAGED_AGENT_AUTH_SIGNING_KEY \
#     -e SPRING_DATASOURCE_URL='jdbc:mysql://<db-host>:3306/qwen_managed_agent' \
#     -e SPRING_DATASOURCE_USERNAME='qwen' \
#     -e SPRING_DATASOURCE_PASSWORD \
#     <image>
# or the deliberately unauthenticated
# QWEN_MANAGED_AGENT_AUTH_ALLOW_INSECURE_BIND=true override.

EXPOSE 8080 4182
USER 10001
ENTRYPOINT ["java", "-jar", "/app/qwen-managed-agent-server.jar"]
