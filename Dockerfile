# Build stage: full deps, compile TypeScript to dist/.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production deps and the compiled output only.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The state volume mounts at /data. A named volume on a path that does not exist
# in the image is created owned by root, and `node` could then never write its
# state — the bot would cold-start every boot and silently report nothing.
# Creating it with the right owner here makes Docker carry that ownership over.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node

CMD ["node", "dist/index.js"]
