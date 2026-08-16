# A stand-in for one machine in the ECS self-hosted pool: Ubuntu, GNU
# findutils, real git, and the Node the runner uses to execute JS actions.
FROM ghcr.io/qwenlm/qwen-code:0.21.3 AS nodesrc

FROM mirror.gcr.io/library/ubuntu:24.04
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates sudo procps \
  && rm -rf /var/lib/apt/lists/*
COPY --from=nodesrc /usr/local/bin/node /usr/local/bin/node
RUN useradd -m -u 1001 -s /bin/bash runner \
  && mkdir -p /runner/_work/qwen-code/qwen-code /srv \
  && chown -R runner:runner /runner
RUN node -v && git --version && find --version | head -1
USER runner
WORKDIR /runner
