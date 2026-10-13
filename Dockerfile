# Cloud Run image. One image, two services:
#   web     node server.js          RUN_WORKER=0
#   worker  /app/start.sh worker    HTTP /health on $PORT (Cloud Run requires a listener)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
ENV AUTH_MODE=local
ENV STORAGE_DRIVER=local
ENV RUN_WORKER=0
RUN npm run build && npm prune --omit=dev && npm install tsx --omit=dev --no-save

FROM node:22-bookworm-slim AS runner
# LibreOffice is part of this image (not a laptop install). Impress renders
# PPTX → PDF; the app then stills each page for Golden / Stability.
# ffmpeg ships ffprobe for video/audio FILE FACTS (duration, codec, Rec.709).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-core \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-writer \
  && rm -rf /var/lib/apt/lists/* \
  && /usr/bin/soffice --version \
  && /usr/bin/ffprobe -version
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
ENV LIBREOFFICE_BIN=/usr/bin/soffice
ENV FFPROBE_BIN=/usr/bin/ffprobe

COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY deploy/start.sh ./start.sh
RUN chmod +x ./start.sh

EXPOSE 8080
CMD ["./start.sh"]
