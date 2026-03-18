import {
  pgTable,
  serial,
  text,
  doublePrecision,
  integer,
  jsonb,
  timestamp,
  index,
  customType,
} from 'drizzle-orm/pg-core';

// Кастомный тип для PostGIS Point
const geography = customType<{ data: string }>({
  dataType() {
    return 'geography(Point, 4326)';
  },
});

const geometryPolygon = customType<{ data: string }>({
  dataType() {
    return 'geometry(Polygon, 4326)';
  },
});

export const cities = pgTable('cities', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  country: text('country'),
  lat: doublePrecision('lat'),
  lon: doublePrecision('lon'),
  bbox: geometryPolygon('bbox'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const clusters = pgTable('clusters', {
  id: serial('id').primaryKey(),
  cityId: integer('city_id').references(() => cities.id),
  centerLat: doublePrecision('center_lat'),
  centerLon: doublePrecision('center_lon'),
  radius: doublePrecision('radius'),
  poiCount: integer('poi_count'),
});

export const pois = pgTable(
  'pois',
  {
    id: serial('id').primaryKey(),
    cityId: integer('city_id').references(() => cities.id),
    osmId: text('osm_id'),
    name: text('name').notNull(),
    category: text('category'),
    lat: doublePrecision('lat').notNull(),
    lon: doublePrecision('lon').notNull(),
    geom: geography('geom'),
    wikidataId: text('wikidata_id'),
    importance: doublePrecision('importance').default(0),
    aiWeight: doublePrecision('ai_weight').default(0),
    popularity: doublePrecision('popularity').default(0),
    clusterId: integer('cluster_id').references(() => clusters.id),
    tags: jsonb('tags'),
    openingHours: text('opening_hours'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    geomIdx: index('idx_pois_geom').using('gist', table.geom),
  }),
);

export const cityDatasetMeta = pgTable('city_dataset_meta', {
  cityId: integer('city_id')
    .primaryKey()
    .references(() => cities.id),
  poiCount: integer('poi_count'),
  clusterCount: integer('cluster_count'),
  generatedAt: timestamp('generated_at').defaultNow(),
});
