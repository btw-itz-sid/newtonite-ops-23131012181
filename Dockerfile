# One image used by both the web app and the worker (different commands in docker-compose.yml).
FROM node:22-bookworm-slim

# Prisma's query engine needs OpenSSL
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
# Dev dependencies are kept on purpose: the worker runs through tsx and `npm test` runs in this image.
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && npm run db:seed && npm run start"]
