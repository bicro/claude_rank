FROM oven/bun:1 AS base
WORKDIR /app

# Fonts for Resvg (OG card rendering). Without these, every <text> in the
# wrapped OG PNG renders as empty glyphs on Linux. DejaVu Sans Mono covers
# ASCII + the U+00B7 middle dot used in headers; fontconfig wires up generic
# "monospace" family resolution.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY server/package.json server/bun.lock ./server/
RUN cd server && bun install --frozen-lockfile

# Copy source
COPY server/ ./server/
COPY website/ ./website/

EXPOSE 10000
CMD ["bun", "server/index.ts"]
