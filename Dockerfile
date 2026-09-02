FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY cli/package.json cli/
RUN npm ci

# Runs the suite during the image build, so a broken push cannot become a
# running container. Separate stage, so --target runtime skips it for a fast rebuild.
FROM deps AS check
COPY . .
RUN npm run typecheck && npm test

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY cli/package.json cli/
RUN npm ci --omit=dev --workspace @mockups/server --include-workspace-root
COPY tsconfig.base.json ./
COPY shared/tsconfig.json shared/
COPY server/tsconfig.json server/
COPY shared/src shared/src
COPY server/src server/src
COPY server/drizzle server/drizzle
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start", "--workspace", "@mockups/server"]
