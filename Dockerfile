# One image for the API, the background workers and the migrations.
FROM oven/bun:1.4.4-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
# Bun runs the TypeScript directly; tsconfig.json carries the decorator settings Nest needs
COPY package.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
USER bun
EXPOSE 3000
# Exec form: bun is PID 1 and gets SIGTERM itself, so the graceful shutdown runs
CMD ["bun", "src/main.ts"]
