# Ingester container: WhatsApp ingest (Baileys) + local embeddings + MCP server.
# Runs the TS directly via tsx (simple; fine for a personal service).
FROM node:22-bookworm-slim

WORKDIR /app

# Build deps for native modules (better-sqlite3, onnxruntime-node) + CA certs.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install deps (incl. tsx — we run TS directly). Layer cached unless lockfile changes.
COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

# Data + model cache live on a mounted volume.
ENV COMMS_DATA_DIR=/data
ENV MODEL_CACHE_DIR=/data/models
# Bind MCP on all interfaces so the zeroclaw container can reach it over the
# compose network (NOT just container-localhost).
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8765

EXPOSE 8765
CMD ["npx", "tsx", "src/index.ts"]
