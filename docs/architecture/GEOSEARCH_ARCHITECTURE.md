# Geosearch Architecture

## Текущая реализация (v2)

### Стек провайдеров

```
Tier 1: Redis cache (geo:suggest:{query}, TTL 7d) ← TODO: при подключении Redis
Tier 2: DaData (RU) + Nominatim WW — параллельно, merge + score + dedup
Tier 3: Photon WW (lang=en) → Yandex (если score < 2)
```

### Цепочка (v2, параллельная)

```
query
  └─► Redis? → return cached                        (< 5ms)
  └─► [DaData + Nominatim WW] parallel (timeout 800ms)
        ├─ DaData: фильтр по city/settlement/region (не street)
        ├─ Nominatim WW: accept-language=ru,en
        └─ merge → dedup by coords (±0.01°) → score → top 10
              score < 2 → Photon WW → Yandex
```

### Scoring

```
final_score = text_match_score × 2 + type_bonus + importance_bonus

text_match_score:
  3.0 — display_name starts with query
  2.5 — exact word match (\b word \b)
  1.5 — substring match
  0.5 — fuzzy (levenshtein ≤ 2) — TODO

type_bonus:
  +2.0 — city, town, municipality, airport, aerodrome
  +1.5 — village (если запрос < 8 символов)
  +1.0 — tourism, leisure, historic
  +0.5 — amenity (ресторан, отель)
   0.0 — highway, waterway (улицы, реки)
  -1.0 — building, shop

importance_bonus (Nominatim):
  importance (0–1) × 2.0
```

### Почему параллельный DaData + Nominatim WW

**Проблема sequential:**
- DaData находит деревню "Париж" в Челябинске (settlement) → останавливает цепочку
- Пользователь не видит Париж, Франция

**Решение parallel + score:**
- Оба вызова идут параллельно
- Nominatim WW возвращает Париж, Франция с importance ~0.85
- score("Париж, Франция") ≈ 3×2 + 2.0 + 1.7 = 9.7
- score("Париж, Челябинская обл.") ≈ 3×2 + 0.5 + 0.3 = 6.8
- Париж, Франция идёт первым ✓

### Dedup по координатам

```typescript
// Округляем до 2 знаков (~1 км точность)
const key = `${lon.toFixed(2)},${lat.toFixed(2)}`;
```

---

## Roadmap

### v3 (при подключении Redis)
- Redis Tier 1: `geo:suggest:{normalized_query}` TTL 7d
- `geo:suggest:popular:{query}` TTL 30d для топ-запросов

### v4 (при росте трафика)
- PostgreSQL `popular_destinations` таблица (300-500 записей)
- Топ-направления: Турция, ОАЭ, Таиланд, Египет, Грузия, Абхазия, СНГ, РФ
- trigram индекс (`pg_trgm`) + prefix search
- Latency < 5ms для 70-80% запросов

### v5 (при бюджете)
- LocationIQ Autocomplete API как Tier 2 (заточен под as-you-type)
- Rate limiting: Tier 3 max 10% трафика
- A/B тест: city type_bonus +2 vs без бонуса

---

## Провайдеры

| Провайдер | Тип | Покрытие | Лимит | Особенности |
|-----------|-----|----------|-------|-------------|
| DaData | suggest/address | РФ | ~5k/day | Лучшее по РФ, только рус. адреса |
| Nominatim | search | WW | 1 req/s | OSM, class/type фильтрация, importance |
| Photon | search | WW | мягкий rate limit | Быстрее Nominatim, lang=en/de/fr |
| Yandex Suggest | suggest | WW | по ключу | Хорошо по РФ+СНГ, fallback |
| LocationIQ | autocomplete | WW | 5k/day free | Лучший as-you-type, TODO |

---

## Известные ограничения

- Photon: не поддерживает `lang=ru` (только default, de, en, fr)
- DaData: возвращает бизнесы по имени → фильтруем только по geo-полям
- Nominatim public: rate limit 1 req/s → при нагрузке нужен self-hosted или LocationIQ
- DaData settlement "Париж" (Челябинск) — решается scoring, не фильтрацией
