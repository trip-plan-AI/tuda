import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  doublePrecision,
  timestamp,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Enum'ы
export const collaboratorRoleEnum = pgEnum('collaborator_role', [
  'owner',
  'editor',
  'viewer',
]);
export const poiCategoryEnum = pgEnum('poi_category', [
  'museum',
  'park',
  'restaurant',
  'cafe',
  'attraction',
  'shopping',
  'entertainment',
]);
export const transportModeEnum = pgEnum('transport_mode', [
  'driving',
  'foot',
  'bike',
  'direct',
]);

// users
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  photo: text('photo'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// trips
export const trips = pgTable('trips', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  description: text('description'),
  budget: integer('budget'),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  isActive: boolean('is_active').notNull().default(false),
  isPredefined: boolean('is_predefined').notNull().default(false),
  img: text('img'),
  tags: jsonb('tags').$type<string[]>(),
  temp: text('temp'),
  startDate: text('start_date'),
  endDate: text('end_date'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const tripsRelations = relations(trips, ({ many }) => ({
  points: many(routePoints),
}));

// trip_collaborators
export const tripCollaborators = pgTable(
  'trip_collaborators',
  {
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: collaboratorRoleEnum('role').notNull().default('viewer'),
    isActive: boolean('is_active').notNull().default(false),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tripId, t.userId] })],
);

// route_points
export const routePoints = pgTable('route_points', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id')
    .notNull()
    .references(() => trips.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  lat: doublePrecision('lat').notNull(),
  lon: doublePrecision('lon').notNull(),
  budget: integer('budget'),
  visitDate: text('visit_date'),
  imageUrl: text('image_url'),
  order: integer('order').notNull().default(0),
  address: text('address'),
  transportMode: text('transport_mode').notNull().default('driving'),
  isTitleLocked: boolean('is_title_locked').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const routePointsRelations = relations(routePoints, ({ one }) => ({
  trip: one(trips, {
    fields: [routePoints.tripId],
    references: [trips.id],
  }),
}));

// optimization_results
export const optimizationResults = pgTable('optimization_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id')
    .notNull()
    .references(() => trips.id, { onDelete: 'cascade' }),
  originalOrder: jsonb('original_order').notNull(),
  optimizedOrder: jsonb('optimized_order').notNull(),
  savedKm: doublePrecision('saved_km').notNull().default(0),
  savedRub: doublePrecision('saved_rub').notNull().default(0),
  savedHours: doublePrecision('saved_hours').notNull().default(0),
  transportMode: transportModeEnum('transport_mode').notNull().default('driving'),
  params: jsonb('params'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ai_sessions
export const aiSessions = pgTable('ai_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').references(() => trips.id, { onDelete: 'set null' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  messages: jsonb('messages').notNull().default('[]'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
