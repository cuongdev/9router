#!/usr/bin/env bash
set -e

# Stop/remove the old container. Never touches the named volume,
# so 9router-data (config + DB) persists across restarts.
docker stop 9router 2>/dev/null || true
docker rm 9router 2>/dev/null || true

docker build -t 9router .

docker run -d --name 9router --restart unless-stopped \
  -p 20128:20128 \
  --env-file .env \
  -e DATA_DIR=/app/data \
  -v 9router-data:/app/data \
  9router
