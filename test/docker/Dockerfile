# Test environment for memory-tools migration
# Tests upgrade path from v1 to v2

FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app/memory-tools

# Create test user home
RUN mkdir -p /home/testuser/.openclaw/memory/tools \
    && mkdir -p /home/testuser/.openclaw/memories

ENV HOME=/home/testuser

# Copy package files first for better caching
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Make test script executable
RUN chmod +x /app/memory-tools/test/docker/test-migration.sh

# Default command runs the migration test
CMD ["/app/memory-tools/test/docker/test-migration.sh"]
