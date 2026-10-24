# Scranton Branch server image: Node + git + the agent CLIs, no Chromium.
#
#   docker build -f packaging/server/Dockerfile -t scranton-branch-server .
#   docker compose -f packaging/server/docker-compose.yml up -d
#
# AGENT_CLIS picks which agent CLIs are baked in (npm package names).

FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
# Only what the server bundle needs to build: no Electron download, no
# desktop native rebuild.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN node tools/build-server.cjs \
 && cd out/server && npm install --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/*/src node_modules/*/deps node_modules/*/build/Release/obj* \
 && find node_modules -name '*.map' -delete

FROM node:22-bookworm-slim
ARG AGENT_CLIS="@anthropic-ai/claude-code"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*' \
 && groupadd --gid 1001 office \
 && useradd --create-home --uid 1001 --gid office --shell /bin/bash agent \
 && if [ -n "$AGENT_CLIS" ]; then npm install -g $AGENT_CLIS && npm cache clean --force; fi
COPY --from=build /src/out/server /opt/scranton-branch
COPY packaging/server/docker-entrypoint.sh /usr/local/bin/sb-entrypoint
RUN chmod +x /usr/local/bin/sb-entrypoint
# SB_DATA_DIR, SB_OFFICE and SB_AGENT_* default in the entrypoint (/data,
# /office, uid/gid 1001, /home/agent, agent), after any SB_* or older MD_* override.
ENV NODE_ENV=production
VOLUME ["/data", "/office", "/home/agent"]
ENTRYPOINT ["tini", "--", "sb-entrypoint"]
