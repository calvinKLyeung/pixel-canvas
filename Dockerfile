FROM node:24-slim

# better-sqlite3, sharp and argon2 are native modules: compiled for one OS, CPU and Node
# version. They normally download a prebuilt Linux binary; these are the fallback for when
# none matches and npm has to compile from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies before the source, so this layer - and the native builds in it - is reused
# on every deploy that does not touch package*.json.
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:client

ENV NODE_ENV=production
EXPOSE 8000
CMD ["npx", "tsx", "src/server/index.ts"]
