# syntax=docker/dockerfile:1

# Builder: install workspace deps and compile the server to JS.
FROM node:24-slim AS builder
WORKDIR /app

# Lockfile + manifests first so npm ci is cached independently of source.
# The lockfile already resolves against the public npm registry; no custom registry.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci

# Build only the server workspace (tsc -> server/dist).
COPY server ./server
RUN npm run build --workspace=@telugu-practice/server

# Runtime: ship node_modules + compiled server only.
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Hoisted workspace deps live at the root node_modules; ESM resolution from
# /app/server/dist/index.js walks up to /app/node_modules.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist

# Fly sets PORT (defaults to internal_port = 8080); the app reads process.env.PORT.
EXPOSE 8080

CMD ["node","server/dist/index.js"]
