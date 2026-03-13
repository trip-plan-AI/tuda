#!/bin/bash
# Export PostgreSQL database dump for Docker initialization

set -e

DB_NAME="${1:-trip_dev}"
DB_USER="${2:-postgres}"
OUTPUT_DIR="./docker/postgres-init"

echo "📤 Экспортирую database dump..."
echo "   Database: $DB_NAME"
echo "   Output: $OUTPUT_DIR/01-init.dump"

# Create output directory if it doesn't exist
mkdir -p "$OUTPUT_DIR"

# Export database in custom format (compressed, faster restore)
pg_dump -U "$DB_USER" -F custom -f "$OUTPUT_DIR/01-init.dump" "$DB_NAME"

echo "✅ Dump экспортирован:"
ls -lh "$OUTPUT_DIR/01-init.dump"

# Also create SQL version for reference
echo ""
echo "📝 Создаю текстовую версию для reference..."
pg_dump -U "$DB_USER" -F plain "$DB_NAME" > "$OUTPUT_DIR/01-init.sql" 2>&1 || true

echo "✅ Готово!"
echo ""
echo "Использование в Docker:"
echo "  docker-compose up -d  # PostgreSQL инициализируется автоматически"
