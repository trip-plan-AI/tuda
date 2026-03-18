-- Идемпотентное создание ENUM типов для PostgreSQL
-- Этот файл применяется ПЕРЕД основными миграциями Drizzle
-- Используем DO блоки для проверки существования типов перед созданием

DO $$
BEGIN
  -- collaborator_role enum
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'collaborator_role') THEN
    CREATE TYPE "public"."collaborator_role" AS ENUM ('owner', 'editor', 'viewer');
  END IF;
END
$$;

DO $$
BEGIN
  -- poi_category enum
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'poi_category') THEN
    CREATE TYPE "public"."poi_category" AS ENUM ('museum', 'park', 'restaurant', 'cafe', 'attraction', 'shopping', 'entertainment');
  END IF;
END
$$;

DO $$
BEGIN
  -- transport_mode enum
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transport_mode') THEN
    CREATE TYPE "public"."transport_mode" AS ENUM ('driving', 'foot', 'bike', 'direct');
  END IF;
END
$$;
