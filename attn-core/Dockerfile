# Multi-stage build: compiles TypeScript, then runs production
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --production
COPY --from=builder /app/dist/ ./dist/
EXPOSE 9742
CMD ["node", "dist/index.js"]
