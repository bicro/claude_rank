FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY server/package.json server/bun.lock ./server/
RUN cd server && bun install --frozen-lockfile

# Copy source
COPY server/ ./server/
COPY website/ ./website/

EXPOSE 10000
CMD ["bun", "server/index.ts"]
