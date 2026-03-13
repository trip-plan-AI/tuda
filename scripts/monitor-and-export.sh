#!/bin/bash
# Monitor GeoNames loader and automatically export dump when done

set -e

DB_NAME="${1:-trip_dev}"
DB_USER="${2:-postgres}"
CHECK_INTERVAL=30  # Check every 30 seconds

echo "⏱️  Мониторю загрузку городов..."
echo "   Проверка каждые $CHECK_INTERVAL секунд"
echo ""

while true; do
  # Get current count
  COUNT=$(psql -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM cities;" 2>/dev/null || echo "0")
  PERCENT=$((COUNT * 100 / 100000))

  if [ "$COUNT" == "100000" ]; then
    echo ""
    echo "✅ ЗАГРУЗКА ЗАВЕРШЕНА! ($COUNT городов)"
    echo ""
    echo "📤 Экспортирую database dump..."

    # Run export script
    bash ./scripts/export-db-dump.sh "$DB_NAME" "$DB_USER"

    echo ""
    echo "✅ Все готово к развёртыванию на сервере!"
    echo "   Dump находится в: ./docker/postgres-init/"
    exit 0
  else
    echo "[$(date '+%H:%M:%S')] Загружено: $COUNT / 100000 ($PERCENT%)"
  fi

  sleep $CHECK_INTERVAL
done
