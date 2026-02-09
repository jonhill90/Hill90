#!/bin/bash
# Backup Hill90 data and volumes

set -e

BACKUP_DIR="backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "================================"
echo "Hill90 Backup"
echo "================================"
echo "Backup directory: $BACKUP_DIR"
echo ""

# Backup Docker volumes
echo "Backing up Docker volumes..."
docker run --rm \
  -v postgres-data:/data \
  -v "$(pwd)/$BACKUP_DIR":/backup \
  alpine tar czf /backup/postgres-data.tar.gz -C /data .

docker run --rm \
  -v traefik-certs:/data \
  -v "$(pwd)/$BACKUP_DIR":/backup \
  alpine tar czf /backup/traefik-certs.tar.gz -C /data .

# Backup database
echo "Backing up database..."
docker exec postgres pg_dumpall -U hill90 > "$BACKUP_DIR/database.sql"

echo ""
echo "================================"
echo "Backup Complete!"
echo "================================"
echo "Location: $BACKUP_DIR"
