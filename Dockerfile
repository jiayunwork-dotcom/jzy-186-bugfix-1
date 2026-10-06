# ---- build stage: compile TypeScript and carry SQL migrations into dist ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json \
 && cp src/migrations/*.sql dist/migrations/

# ---- runtime stage ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
# Apply migrations then start.
CMD ["sh", "-c", "node dist/migrations/run.js && node dist/main.js"]
