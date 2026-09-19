FROM maven:3.9.11-eclipse-temurin-21 AS build

WORKDIR /workspace
COPY packages/sdk-java/qwencode packages/sdk-java/qwencode
COPY packages/sdk-java/runtime-broker packages/sdk-java/runtime-broker
COPY packages/sdk-java/managed-agent-server packages/sdk-java/managed-agent-server

RUN mvn --batch-mode --no-transfer-progress \
      -f packages/sdk-java/qwencode/pom.xml \
      -DskipTests -Dgpg.skip=true install \
    && mvn --batch-mode --no-transfer-progress \
      -f packages/sdk-java/runtime-broker/pom.xml \
      -DskipTests install \
    && mvn --batch-mode --no-transfer-progress \
      -f packages/sdk-java/managed-agent-server/pom.xml \
      -DskipTests package

FROM eclipse-temurin:21-jre

WORKDIR /app
COPY --from=build \
  /workspace/packages/sdk-java/managed-agent-server/target/qwen-managed-agent-server-0.1.0-alpha.jar \
  /app/qwen-managed-agent-server.jar

EXPOSE 8080 4190
USER 10001
ENTRYPOINT ["java", "-jar", "/app/qwen-managed-agent-server.jar"]
