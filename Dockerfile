FROM oven/bun:1.1

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the source.
COPY . .

ENV NODE_ENV=production

# The process role (api | worker | all) is chosen via APP_ROLE at runtime.
EXPOSE 3000
CMD ["bun", "src/main.ts"]
