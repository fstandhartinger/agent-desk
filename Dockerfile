FROM node:24-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
ARG SOURCE_COMMIT=
ENV DESK_COMMIT=$SOURCE_COMMIT
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY gateway/package*.json ./
RUN npm ci --omit=dev
COPY gateway/src ./src
COPY --from=web /web/dist ./public
ARG SOURCE_COMMIT=
ENV NODE_ENV=production PORT=8080 SOURCE_COMMIT=$SOURCE_COMMIT
EXPOSE 8080
USER node
# Structured JSON logs + request ids (logging standard, AGENTS.md; logkit/README.md). No IPs or user agents.
COPY logkit ./logkit
ENV LOG_APP=agent-desk LOG_IP=0 LOG_UA=0
CMD ["node", "-r", "./logkit/logkit-preload.cjs", "src/server.js"]