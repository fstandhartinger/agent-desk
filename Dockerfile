FROM node:24-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY gateway/package*.json ./
RUN npm ci --omit=dev
COPY gateway/src ./src
COPY --from=web /web/dist ./public
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
