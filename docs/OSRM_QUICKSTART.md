# OSRM Quick Start Guide

Развертывание OSRM локально или на production (5 минут для разработки, 2+ часа для production).

---

## 🚀 Разработка (локально, 5 минут)

### Требуется

- Docker + Docker Compose
- 4 GB RAM
- 10 GB свободного места

### Инструкция

**1. Создать рабочую папку**
```bash
mkdir -p ~/osrm-local && cd ~/osrm-local
```

**2. Скачать OSM данные (выбрать один вариант)**

```bash
# ВАРИАНТ A: ЦФО (быстро, ~500 MB) ← РЕКОМЕНДУЕТСЯ ПЕРВЫЙ РАЗ
wget https://download.geofabrik.de/europe/russia/central-fed-district-latest.osm.pbf -O region.osm.pbf

# ВАРИАНТ B: Вся Россия (полно, ~1.5 GB)
# wget https://download.geofabrik.de/russia-latest.osm.pbf -O region.osm.pbf
```

**3. Создать `docker-compose.yml`**

```bash
cat > docker-compose.yml << 'COMPOSE'
version: '3.8'

services:
  osrm-backend:
    image: osrm/osrm-backend:v5.28
    container_name: osrm-local
    ports:
      - "5000:5000"
    volumes:
      - ./region.osm.pbf:/data/region.osm.pbf:ro
      - ./osrm-cache:/data
    environment:
      - OSRM_ALGORITHM=mld
    command: |
      sh -c '
        if [ ! -f /data/region.osrm.customized ]; then
          echo "⏳ Обработка данных (2-5 минут)..."
          osrm-extract -p /opt/osrm/profiles/car.lua /data/region.osm.pbf
          osrm-partition /data/region.osrm.extracted
          osrm-customize /data/region.osrm.partitioned
          echo "✅ Готово!"
        fi
        echo "🚀 OSRM сервер запущен на http://localhost:5000"
        osrm-routed --algorithm mld /data/region.osrm.customized
      '
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5000/status"]
      interval: 10s
      timeout: 5s
      retries: 3
COMPOSE
```

**4. Запустить контейнер**

```bash
docker-compose up -d osrm-backend

# Смотреть логи (первый запуск 2-5 минут)
docker-compose logs -f osrm-backend

# Когда появится: "[server] Running and waiting for requests" → готово!
# Выход: Ctrl+C
```

**5. Обновить приложение**

```bash
# В другом терминале, в папке travel-planner
echo "NEXT_PUBLIC_OSRM_URL=http://localhost:5000" >> apps/web/.env.local
```

**6. Запустить приложение**

```bash
# В папке travel-planner
pnpm dev --filter web

# Открыть http://localhost:3000
# Добавить 2+ точки на карту → маршруты мгновенно!
```

### Основные команды

```bash
cd ~/osrm-local

# Остановить (данные остаются)
docker-compose down

# Перезапустить
docker-compose restart osrm-backend

# Просмотреть логи
docker-compose logs -f osrm-backend

# Проверить что работает
curl http://localhost:5000/status
```

---

## 🔧 Production (на сервере, 2+ часа)

**Полная инструкция:** [`docs/OSRM_SETUP.md`](./OSRM_SETUP.md) (Опция 3)

### Краткое резюме

1. SSH на сервер (Ubuntu 22.04+, 8 GB RAM, 100 GB SSD)
2. Скачать russia-latest.osm.pbf (~1.5 GB)
3. Создать docker-compose.yml и запустить
4. Установить Nginx + Let's Encrypt SSL
5. Обновить .env.production в приложении
6. Готово! OSRM на https://routing.yourdomain.com

**Подробнее в [`docs/OSRM_SETUP.md`](./OSRM_SETUP.md)**

---

## Проблемы?

| Проблема | Решение |
|----------|---------|
| **Connection refused на localhost:5000** | Проверить статус: `docker-compose ps` |
| **Обработка очень долгая** | Это нормально. Ждать (2-5 минут для ЦФО) |
| **Нет свободного места** | Docker требует 20+ GB временного. Очистить: `docker system prune -a` |
| **Маршруты через поля** | Проверить что в compose используется `car.lua` профиль |

Подробнее: [`docs/OSRM_SETUP.md`](./OSRM_SETUP.md#проблемы)

---

## Ссылки

- **Разработка**: [`docs/OSRM_SETUP.md`](./OSRM_SETUP.md) - Опция 2
- **Production**: [`docs/OSRM_SETUP.md`](./OSRM_SETUP.md) - Опция 3
- **Tiles (визуально)**: [`docs/CUSTOM_TILES_SETUP.md`](./CUSTOM_TILES_SETUP.md)
