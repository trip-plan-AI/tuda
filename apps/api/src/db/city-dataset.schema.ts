import {
  pgTable,
  uuid,
  text,
  real,
  timestamp,
  index,
  unique,
  customType,
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Кастомный тип для PostGIS Point
const geography = customType<{ data: string }>({
  dataType() {
    return 'geography(Point, 4326)';
  },
});

// Таблица для хранения городов, для которых собраны датасеты
export const cities = pgTable(
  'ai_cities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    country: text('country'),
    lat: real('lat').notNull(),
    lon: real('lon').notNull(),
    bbox: jsonb('bbox'), // Храним как { minLat, maxLat, minLon, maxLon }
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index('ai_cities_name_idx').on(t.name),
  }),
);

// Таблица для кэширования сырых ответов Overpass API (узкое горлышко)
export const overpassCache = pgTable(
  'ai_overpass_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    city: text('city').notNull(),
    queryHash: text('query_hash').notNull(),
    responseJson: jsonb('response_json').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    queryIdx: index('ai_overpass_query_idx').on(t.city, t.queryHash),
  }),
);

// Таблица для хранения обработанных и оцененных точек интереса (POI)
export const pois = pgTable(
  'ai_pois',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cityId: uuid('city_id')
      .notNull()
      .references(() => cities.id, { onDelete: 'cascade' }),
    osmId: text('osm_id').notNull(),
    name: text('name').notNull(),
    category: text('category'),
    lat: real('lat').notNull(),
    lon: real('lon').notNull(),
    geom: geography('geom'),
    wikidataId: text('wikidata_id'),
    importance: real('importance').default(0),
    aiWeight: real('ai_weight').notNull().default(0),
    popularity: real('popularity').default(0),
    clusterId: uuid('cluster_id'), // Будет обновлено после кластеризации
    duration: real('duration').default(60), // Длительность посещения в минутах
    openingHours: text('opening_hours'),
    tags: jsonb('tags'),
    address: text('address'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    cityIdIdx: index('ai_pois_city_id_idx').on(t.cityId),
    geomIdx: index('idx_pois_geom').using('gist', t.geom),
    osmIdUnique: unique('ai_pois_city_id_osm_id_unique').on(t.cityId, t.osmId),
  }),
);

// Таблица для хранения кластеров (групп POI)
export const clusters = pgTable('ai_clusters', {
  id: uuid('id').primaryKey().defaultRandom(),
  cityId: uuid('city_id')
    .notNull()
    .references(() => cities.id, { onDelete: 'cascade' }),
  centerLat: real('center_lat').notNull(),
  centerLon: real('center_lon').notNull(),
  radius: real('radius'),
  poiCount: real('poi_count'),
  totalScore: real('total_score').default(0), // Для быстрого ранжирования районов
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Таблица для кэширования описаний маршрутов от LLM
export const explanationCache = pgTable('ai_explanation_cache', {
  id: uuid('id').primaryKey().defaultRandom(),
  routeHash: text('route_hash').notNull().unique(), // city + poi_ids
  explanation: text('explanation').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Мета-данные для контроля кэша
export const cityDatasetMeta = pgTable('ai_city_dataset_meta', {
  cityId: uuid('city_id')
    .primaryKey()
    .references(() => cities.id, { onDelete: 'cascade' }),
  poiCount: real('poi_count'),
  clusterCount: real('cluster_count'),
  generatedAt: timestamp('generated_at').notNull().defaultNow(),
});

// Связи для Drizzle ORM
export const citiesRelations = relations(cities, ({ many }) => ({
  pois: many(pois),
  clusters: many(clusters),
}));

export const poisRelations = relations(pois, ({ one }) => ({
  city: one(cities, {
    fields: [pois.cityId],
    references: [cities.id],
  }),
  cluster: one(clusters, {
    fields: [pois.clusterId],
    references: [clusters.id],
  }),
}));

export const clustersRelations = relations(clusters, ({ one, many }) => ({
  city: one(cities, {
    fields: [clusters.cityId],
    references: [cities.id],
  }),
  pois: many(pois),
}));
