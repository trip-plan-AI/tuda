# Dev Guide — Travel Planner MVP
# Версия: 2.0 | Дата: 2026-03-04
# Привязан к: decomposition.json (TRI-01 — TRI-40)

> Это внутренний технический гайд для сборки проекта.
> После завершения каждой задачи сообщаю пользователю: «Закрыл TRI-XX — [название]».
> Пользователь ставит галочку в YouGile.

---

## СОГЛАШЕНИЯ И КРИТИЧЕСКИЕ ФАКТЫ

```
Monorepo:   /home/dmitriy/projects/trip/travel-planner/
Backend:    apps/api/src/
Frontend:   apps/web/src/
Alias:      @/* → ./src/*  (tsconfig.json)
Port API:   3001
Port Web:   3000
```

**FSD слои** (импорт только сверху вниз):
`app → views → widgets → features → entities → shared`

**ВАЖНО:** слой `views/` — НЕ `pages/`, иначе Next.js Pages Router!

**shadcn** компоненты: устанавливать через `pnpm dlx shadcn@latest add <component>` из `apps/web/`
→ ложатся в `@/shared/ui/`

**Yandex Maps:** НЕ npm-пакет, динамический `<script>` loader.

**JWT хранение:** localStorage (для API calls) + cookie (для SSR middleware.ts).

**WebSocket правило:** события WS → только Zustand store, НИКОГДА не вызывать API-запросы.

---

## BACKEND (TRI-01 — TRI-20)

---

### TRI-01 — Подключение Drizzle ORM
`branch: feature/TRI-01-backend-drizzle-setup`

**Зависимости:**
```bash
cd apps/api
pnpm add drizzle-orm pg
pnpm add -D drizzle-kit @types/pg
```

**Файлы создать:**
- `apps/api/src/db/db.module.ts`

**`db.module.ts`:**
```ts
import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export const DRIZZLE = Symbol('DRIZZLE')

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pool = new Pool({ connectionString: config.get('DATABASE_URL') })
        return drizzle(pool, { schema })
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DbModule {}
```

**`drizzle.config.ts`** (в корне apps/api/):
```ts
import type { Config } from 'drizzle-kit'
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  driver: 'pg',
  dbCredentials: { connectionString: process.env.DATABASE_URL! },
} satisfies Config
```

**`package.json`** apps/api/ — добавить скрипты:
```json
"db:push": "drizzle-kit push:pg",
"db:studio": "drizzle-kit studio"
```

**Проверка:** `pnpm db:push` без ошибок.

---

### TRI-02 — Создание схем базы данных
`branch: feature/TRI-02-backend-db-schemas`

**Файлы изменить:**
- `apps/api/src/db/schema.ts` — полностью перезаписать

**Схема — 3 enum'а + 6 таблиц:**
```ts
import { pgTable, pgEnum, uuid, text, boolean, integer, jsonb, doublePrecision, timestamp, primaryKey } from 'drizzle-orm/pg-core'

// Enum'ы
export const collaboratorRoleEnum = pgEnum('collaborator_role', ['owner', 'editor', 'viewer'])
export const poiCategoryEnum = pgEnum('poi_category', ['museum', 'park', 'restaurant', 'cafe', 'attraction', 'shopping', 'entertainment'])
export const transportModeEnum = pgEnum('transport_mode', ['walk', 'transit', 'auto'])

// users
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  photo: text('photo'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// trips
export const trips = pgTable('trips', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  description: text('description'),
  budget: integer('budget'),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  isActive: boolean('is_active').notNull().default(true),
  isPredefined: boolean('is_predefined').notNull().default(false),
  startDate: text('start_date'),
  endDate: text('end_date'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// trip_collaborators
export const tripCollaborators = pgTable('trip_collaborators', {
  tripId: uuid('trip_id').notNull().references(() => trips.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: collaboratorRoleEnum('role').notNull().default('viewer'),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.tripId, t.userId] }) }))

// route_points
export const routePoints = pgTable('route_points', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').notNull().references(() => trips.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  lat: doublePrecision('lat').notNull(),
  lon: doublePrecision('lon').notNull(),
  budget: integer('budget'),
  visitDate: text('visit_date'),
  imageUrl: text('image_url'),
  order: integer('order').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// optimization_results
export const optimizationResults = pgTable('optimization_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').notNull().references(() => trips.id, { onDelete: 'cascade' }),
  originalOrder: jsonb('original_order').notNull(),   // string[]
  optimizedOrder: jsonb('optimized_order').notNull(), // string[]
  savedKm: doublePrecision('saved_km').notNull().default(0),
  savedRub: doublePrecision('saved_rub').notNull().default(0),
  savedHours: doublePrecision('saved_hours').notNull().default(0),
  transportMode: transportModeEnum('transport_mode').notNull().default('auto'),
  params: jsonb('params'), // { consumption?, fuelPrice?, tollFees?, transitFarePerKm? }
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// ai_sessions
export const aiSessions = pgTable('ai_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').references(() => trips.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  messages: jsonb('messages').notNull().default('[]'), // Message[], max 10
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
```

**Проверка:** `pnpm db:push` — 6 таблиц созданы, `\dt` в psql показывает все.

---

### TRI-03 — transport_mode и глобальные настройки
`branch: feature/TRI-03-backend-global-config`

**Файлы изменить:**
- `apps/api/src/main.ts`
- `apps/api/src/app.module.ts`

**`main.ts`:**
```ts
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix('api')
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  app.enableCors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:3000' })
  await app.listen(3001)
}
bootstrap()
```

**`app.module.ts`** — добавить ConfigModule + DbModule:
```ts
import { ConfigModule } from '@nestjs/config'
import { DbModule } from './db/db.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '../../.env' }),
    DbModule,
    // остальные модули...
  ],
})
export class AppModule {}
```

**`.env`** (корень monorepo `travel-planner/`) — убедиться что есть:
```
DATABASE_URL=postgresql://user:pass@localhost:5432/tripdb
JWT_SECRET=supersecret
JWT_EXPIRES_IN=7d
FRONTEND_URL=http://localhost:3000
OPENAI_API_KEY=sk-...
YANDEX_GPT_API_KEY=...
YANDEX_MAPS_API_KEY=...
YANDEX_FOLDER_ID=...
REDIS_URL=redis://localhost:6379
NEXT_PUBLIC_API_URL=http://localhost:3001/api
NEXT_PUBLIC_YANDEX_MAPS_KEY=...
```

**Проверка:** `pnpm dev` (api) — сервер стартует на 3001 без ошибок.

---

### TRI-04 — Настройка JWT и Passport.js
`branch: feature/TRI-04-backend-auth-jwt`

**Зависимости:**
```bash
cd apps/api
pnpm add @nestjs/passport @nestjs/jwt passport passport-jwt passport-local
pnpm add -D @types/passport-jwt @types/passport-local
```

**Файлы создать:**
- `apps/api/src/auth/auth.module.ts`
- `apps/api/src/auth/strategies/jwt.strategy.ts`
- `apps/api/src/auth/strategies/local.strategy.ts`
- `apps/api/src/auth/guards/jwt-auth.guard.ts`
- `apps/api/src/auth/decorators/current-user.decorator.ts`

**`auth.module.ts`:**
```ts
import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { ConfigService } from '@nestjs/config'

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get('JWT_SECRET'),
        signOptions: { expiresIn: cfg.get('JWT_EXPIRES_IN', '7d') },
      }),
    }),
  ],
  providers: [JwtStrategy, LocalStrategy, AuthService],
  controllers: [AuthController],
  exports: [JwtModule],
})
export class AuthModule {}
```

**`jwt.strategy.ts`:**
```ts
import { Injectable } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(cfg: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: cfg.get('JWT_SECRET'),
    })
  }
  validate(payload: { sub: string; email: string }) {
    return { id: payload.sub, email: payload.email }
  }
}
```

**`jwt-auth.guard.ts`:**
```ts
import { Injectable } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

**`current-user.decorator.ts`:**
```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common'
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user
)
```

**Проверка:** стратегия регистрируется без ошибок при старте.

---

### TRI-05 — Эндпоинты авторизации
`branch: feature/TRI-05-backend-auth-endpoints`

**Файлы создать:**
- `apps/api/src/auth/auth.controller.ts`
- `apps/api/src/auth/dto/create-user.dto.ts`
- `apps/api/src/auth/dto/login.dto.ts`

**`auth.controller.ts`:**
```ts
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() dto: CreateUserDto) {
    return this.authService.register(dto)
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto)
  }
}
// Оба эндпоинта БЕЗ JwtAuthGuard (публичные)
// Возврат: { accessToken: string }
```

**DTO:**
```ts
// create-user.dto.ts
export class CreateUserDto {
  @IsEmail() email: string
  @IsString() @MinLength(6) password: string
  @IsString() name: string
}

// login.dto.ts
export class LoginDto {
  @IsEmail() email: string
  @IsString() password: string
}
```

**Проверка:** `POST /api/auth/register` с valid body → `{ accessToken }`.

---

### TRI-06 — Хэширование пароля
`branch: feature/TRI-06-backend-auth-bcrypt`

**Зависимости:**
```bash
cd apps/api && pnpm add bcrypt && pnpm add -D @types/bcrypt
```

**Файлы создать:**
- `apps/api/src/auth/auth.service.ts`
- `apps/api/src/users/users.service.ts`

**`auth.service.ts`:**
```ts
import * as bcrypt from 'bcrypt'

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
    private jwtService: JwtService,
  ) {}

  async register(dto: CreateUserDto) {
    const existing = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email)
    })
    if (existing) throw new ConflictException('Email already in use')

    const passwordHash = await bcrypt.hash(dto.password, 10)
    const [user] = await this.db.insert(schema.users)
      .values({ email: dto.email, passwordHash, name: dto.name })
      .returning()

    return { accessToken: this.signToken(user.id, user.email) }
  }

  async login(dto: LoginDto) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email)
    })
    if (!user) throw new UnauthorizedException('Invalid credentials')

    const valid = await bcrypt.compare(dto.password, user.passwordHash)
    if (!valid) throw new UnauthorizedException('Invalid credentials')

    return { accessToken: this.signToken(user.id, user.email) }
  }

  private signToken(userId: string, email: string) {
    return this.jwtService.sign({ sub: userId, email })
  }
}
```

**Проверка:**
```bash
curl -X POST http://localhost:3001/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@test.com","password":"123456","name":"Test"}'
# → { "accessToken": "eyJ..." }
```

---

### TRI-07 — CRUD /trips
`branch: feature/TRI-07-backend-trips-crud`

**Файлы создать:**
- `apps/api/src/trips/trips.module.ts`
- `apps/api/src/trips/trips.controller.ts`
- `apps/api/src/trips/trips.service.ts`
- `apps/api/src/trips/dto/create-trip.dto.ts`
- `apps/api/src/users/users.module.ts`
- `apps/api/src/users/users.controller.ts`

**`trips.controller.ts`:**
```ts
@Controller('trips')
@UseGuards(JwtAuthGuard)
export class TripsController {
  // ВАЖНО: predefined ВЫШЕ :id — иначе NestJS парсит 'predefined' как UUID!
  @Get('predefined')
  @Public() // или убрать guard отдельно через @SkipAuth()
  getPredefined() { return this.tripsService.findPredefined() }

  @Get()
  getAll(@CurrentUser() user: { id: string }) {
    return this.tripsService.findByOwner(user.id)
  }

  @Post()
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateTripDto) {
    return this.tripsService.create(user.id, dto)
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.tripsService.findByIdWithAccess(id, user.id)
  }

  @Patch(':id')
  update(@Param('id') id: string, @CurrentUser() user: { id: string }, @Body() dto: UpdateTripDto) {
    return this.tripsService.update(id, user.id, dto)
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.tripsService.remove(id, user.id)
  }
}
```

**`trips.service.ts` — ключевые методы:**
```ts
findByOwner(userId: string) {
  return this.db.query.trips.findMany({
    where: eq(trips.ownerId, userId),
    orderBy: [desc(trips.createdAt)],
  })
}

findPredefined() {
  return this.db.query.trips.findMany({ where: eq(trips.isPredefined, true) })
}

async findByIdWithAccess(id: string, userId: string) {
  const trip = await this.db.query.trips.findFirst({ where: eq(trips.id, id) })
  if (!trip) throw new NotFoundException()
  // проверить: owner или collaborator
  if (trip.ownerId !== userId) {
    const collab = await this.db.query.tripCollaborators.findFirst({
      where: and(eq(tripCollaborators.tripId, id), eq(tripCollaborators.userId, userId))
    })
    if (!collab) throw new ForbiddenException()
  }
  return trip
}

async remove(id: string, userId: string) {
  const trip = await this.findById(id)
  if (trip.ownerId !== userId) throw new ForbiddenException('Only owner can delete')
  await this.db.delete(trips).where(eq(trips.id, id))
}
```

**`users.controller.ts`:**
```ts
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  @Get('me')
  getMe(@CurrentUser() user: { id: string }) {
    return this.usersService.findById(user.id)
  }

  @Patch('me')
  updateMe(@CurrentUser() u: { id: string }, @Body() dto: UpdateUserDto) {
    return this.usersService.update(u.id, dto) // только name и photo
  }
}
```

**Проверка:**
```bash
TOKEN="eyJ..."
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/trips
# → []
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  http://localhost:3001/api/trips -d '{"title":"Казань 2026"}'
# → { id, title, ownerId, ... }
```

---

### TRI-08 — CRUD /trips/:id/points
`branch: feature/TRI-08-backend-points-crud`

**Файлы создать:**
- `apps/api/src/route-points/route-points.module.ts`
- `apps/api/src/route-points/route-points.controller.ts`
- `apps/api/src/route-points/route-points.service.ts`
- `apps/api/src/route-points/dto/create-route-point.dto.ts`
- `apps/api/src/route-points/dto/reorder-points.dto.ts`

**`route-points.controller.ts`:**
```ts
@Controller('trips/:tripId/points')
@UseGuards(JwtAuthGuard)
export class RoutePointsController {
  @Get()
  getAll(@Param('tripId') tripId: string) {
    return this.service.findAll(tripId)
  }

  @Post()
  create(@Param('tripId') tripId: string, @Body() dto: CreateRoutePointDto) {
    return this.service.create(tripId, dto)
  }

  @Patch('reorder')  // ВАЖНО: выше :pid!
  reorder(@Param('tripId') tripId: string, @Body() dto: ReorderPointsDto) {
    return this.service.reorder(tripId, dto.orderedIds)
  }

  @Patch(':pid')
  update(@Param('tripId') tripId: string, @Param('pid') pid: string, @Body() dto: UpdateRoutePointDto) {
    return this.service.update(pid, dto)
  }

  @Delete(':pid')
  remove(@Param('tripId') tripId: string, @Param('pid') pid: string) {
    return this.service.remove(tripId, pid)
  }
}
```

**`route-points.service.ts`:**
```ts
async create(tripId: string, dto: CreateRoutePointDto) {
  // order = MAX(order) + 1
  const points = await this.db.query.routePoints.findMany({ where: eq(routePoints.tripId, tripId) })
  const maxOrder = points.reduce((m, p) => Math.max(m, p.order), -1)
  const [point] = await this.db.insert(routePoints)
    .values({ ...dto, tripId, order: maxOrder + 1 })
    .returning()
  return point
}

async remove(tripId: string, pointId: string) {
  await this.db.delete(routePoints).where(eq(routePoints.id, pointId))
  // пересчитать order оставшихся
  const remaining = await this.db.query.routePoints.findMany({
    where: eq(routePoints.tripId, tripId),
    orderBy: [asc(routePoints.order)],
  })
  await this.db.transaction(async tx => {
    for (let i = 0; i < remaining.length; i++) {
      await tx.update(routePoints).set({ order: i }).where(eq(routePoints.id, remaining[i].id))
    }
  })
}

async reorder(tripId: string, orderedIds: string[]) {
  await this.db.transaction(async tx => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx.update(routePoints).set({ order: i })
        .where(and(eq(routePoints.id, orderedIds[i]), eq(routePoints.tripId, tripId)))
    }
  })
}
```

**Проверка:** POST точку → GET точки → reorder → DELETE → order пересчитался.

---

### TRI-09 — Алгоритм Nearest-Neighbor
`branch: feature/TRI-09-backend-tsp-algo`

**Файлы создать:**
- `apps/api/src/optimization/optimization.module.ts`
- `apps/api/src/optimization/optimization.controller.ts`
- `apps/api/src/optimization/optimization.service.ts`
- `apps/api/src/shared/utils/haversine.ts`

**`haversine.ts`:**
```ts
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371 // км
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}
```

**Nearest-Neighbor алгоритм** в `optimization.service.ts`:
```ts
private nearestNeighbor(points: RoutePoint[], W: number[][]): number[] {
  const n = points.length
  const visited = new Set<number>()
  const route = [0]
  visited.add(0)

  while (route.length < n) {
    const current = route[route.length - 1]
    let nextIdx = -1
    let minW = Infinity
    for (let j = 0; j < n; j++) {
      if (!visited.has(j) && W[current][j] < minW) {
        minW = W[current][j]
        nextIdx = j
      }
    }
    visited.add(nextIdx)
    route.push(nextIdx)
  }
  return route // индексы в массиве points
}
```

**`optimization.controller.ts`:**
```ts
@Controller('trips/:id/optimize')
@UseGuards(JwtAuthGuard)
export class OptimizationController {
  @Post()
  optimize(@Param('id') tripId: string, @Body() dto: OptimizeDto) {
    return this.service.optimize(tripId, dto)
  }
}
```

---

### TRI-10 — Расчет веса W
`branch: feature/TRI-10-backend-tsp-weights`

**В `optimization.service.ts`** — метод buildWeightMatrix:
```ts
private buildWeightMatrix(points: RoutePoint[], mode: TransportMode, params: OptimizeParams): number[][] {
  const n = points.length
  const W: number[][] = Array.from({ length: n }, () => Array(n).fill(0))

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const dist = haversine(points[i].lat, points[i].lon, points[j].lat, points[j].lon)
      switch (mode) {
        case 'walk':
          W[i][j] = dist
          break
        case 'transit':
          W[i][j] = dist * (params.transitFarePerKm ?? 3)
          break
        case 'auto':
          W[i][j] = (dist * (params.consumption ?? 8) / 100 * (params.fuelPrice ?? 55)) + (params.tollFees ?? 0)
          break
      }
    }
  }
  return W
}
```

**DTO:**
```ts
export class OptimizeDto {
  @IsEnum(['walk', 'transit', 'auto'])
  transport_mode: 'walk' | 'transit' | 'auto'

  @IsOptional()
  params?: {
    consumption?: number      // л/100км, default 8
    fuelPrice?: number        // ₽/л, default 55
    tollFees?: number         // ₽ разовый платёж, default 0
    transitFarePerKm?: number // ₽/км, default 3
  }
}
```

---

### TRI-11 — Расчет сэкономленных ресурсов
`branch: feature/TRI-11-backend-tsp-savings`

**`optimization.service.ts`** — основной метод `optimize()`:
```ts
async optimize(tripId: string, dto: OptimizeDto) {
  const points = await this.db.query.routePoints.findMany({
    where: eq(routePoints.tripId, tripId),
    orderBy: [asc(routePoints.order)],
  })
  if (points.length < 2) throw new BadRequestException('Need at least 2 points')

  const params = dto.params ?? {}
  const W = this.buildWeightMatrix(points, dto.transport_mode, params)
  const optimizedIdxs = this.nearestNeighbor(points, W)

  // Сумма расстояний (в км)
  const sumDist = (idxs: number[]) =>
    idxs.slice(0, -1).reduce((sum, _, i) =>
      sum + haversine(points[idxs[i]].lat, points[idxs[i]].lon,
                      points[idxs[i+1]].lat, points[idxs[i+1]].lon), 0)

  const originalIdxs = points.map((_, i) => i)
  const origDist = sumDist(originalIdxs)
  const optDist  = sumDist(optimizedIdxs)
  const savedKm  = Math.max(0, origDist - optDist)

  const consumption = params.consumption ?? 8
  const fuelPrice   = params.fuelPrice ?? 55
  const savedRub    = dto.transport_mode === 'auto' ? savedKm * consumption / 100 * fuelPrice : 0
  const savedHours  = savedKm / 80

  const optimizedOrder = optimizedIdxs.map(i => points[i].id)
  const originalOrder  = points.map(p => p.id)

  // Обновить order точек
  await this.routePointsService.reorder(tripId, optimizedOrder)

  // Сохранить результат
  const [result] = await this.db.insert(optimizationResults).values({
    tripId, originalOrder, optimizedOrder,
    savedKm, savedRub, savedHours,
    transportMode: dto.transport_mode,
    params,
  }).returning()

  return { ...result, optimizedOrder }
}
```

**Проверка:** POST `/api/trips/:id/optimize` с `transport_mode: "auto"` → ответ с `savedKm`, `savedRub`, `savedHours`, `optimizedOrder`.

---

### TRI-12 — Настройка Socket.io Gateway
`branch: feature/TRI-12-backend-ws-setup`

**Зависимости:**
```bash
cd apps/api && pnpm add @nestjs/websockets @nestjs/platform-socket.io socket.io
```

**Файлы создать:**
- `apps/api/src/collaboration/collaboration.module.ts`
- `apps/api/src/collaboration/collaboration.gateway.ts`
- `apps/api/src/collaboration/collaboration.service.ts`

**`main.ts`** — добавить Socket.io адаптер:
```ts
import { IoAdapter } from '@nestjs/platform-socket.io'
app.useWebSocketAdapter(new IoAdapter(app))
```

**`collaboration.gateway.ts` — скелет:**
```ts
import { WebSocketGateway, WebSocketServer, SubscribeMessage, ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { JwtService } from '@nestjs/jwt'

@WebSocketGateway({ namespace: '/collaboration', cors: { origin: '*' } })
export class CollaborationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server

  constructor(
    private collabService: CollaborationService,
    private jwtService: JwtService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token
      const payload = this.jwtService.verify(token)
      client.data.userId = payload.sub
      client.data.email = payload.email
    } catch {
      client.disconnect()
    }
  }

  handleDisconnect(client: Socket) {
    this.collabService.removePresence(client.id, this.server)
  }
}
```

**Проверка:** WS клиент подключается к `ws://localhost:3001/collaboration` с `auth: { token }`.

---

### TRI-13 — Логика комнат trip_{id}
`branch: feature/TRI-13-backend-ws-rooms`

**В `collaboration.gateway.ts`:**
```ts
@SubscribeMessage('join:trip')
handleJoin(@ConnectedSocket() client: Socket, @MessageBody() data: { trip_id: string }) {
  const room = `trip_${data.trip_id}`
  client.join(room)
  client.data.tripId = data.trip_id

  const presenceData = this.collabService.addPresence(client.id, {
    userId: client.data.userId,
    tripId: data.trip_id,
    name: client.data.email,
    color: this.collabService.getUserColor(client.data.userId),
  })

  // Сообщить всем в комнате кроме себя
  client.to(room).emit('presence:join', presenceData)
}

@SubscribeMessage('leave:trip')
handleLeave(@ConnectedSocket() client: Socket, @MessageBody() data: { trip_id: string }) {
  const room = `trip_${data.trip_id}`
  client.leave(room)
  client.to(room).emit('presence:leave', { user_id: client.data.userId })
}
```

**`collaboration.service.ts`:**
```ts
const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899']

@Injectable()
export class CollaborationService {
  private presence = new Map<string, { userId: string; tripId: string; name: string; color: string }>()

  addPresence(socketId: string, data: { userId: string; tripId: string; name: string; color: string }) {
    this.presence.set(socketId, data)
    return data
  }

  removePresence(socketId: string, server: Server) {
    const data = this.presence.get(socketId)
    if (data) {
      server.to(`trip_${data.tripId}`).emit('presence:leave', { user_id: data.userId })
      this.presence.delete(socketId)
    }
  }

  getUserColor(userId: string): string {
    let hash = 0
    for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash)
    return COLORS[Math.abs(hash) % COLORS.length]
  }
}
```

---

### TRI-14 — Рассылка событий маршрута
`branch: feature/TRI-14-backend-ws-events`

**В `collaboration.gateway.ts`** — события точек:
```ts
@SubscribeMessage('point:add')
async handlePointAdd(@ConnectedSocket() client: Socket, @MessageBody() data: CreateRoutePointDto & { trip_id: string }) {
  const point = await this.routePointsService.create(data.trip_id, data)
  this.server.to(`trip_${data.trip_id}`).emit('point:added', { point })
}

@SubscribeMessage('point:move')
async handlePointMove(@ConnectedSocket() client: Socket, @MessageBody() data: { trip_id: string; point_id: string; lat: number; lon: number }) {
  await this.routePointsService.update(data.point_id, { lat: data.lat, lon: data.lon })
  this.server.to(`trip_${data.trip_id}`).emit('point:moved', { point_id: data.point_id, coords: { lat: data.lat, lon: data.lon } })
}

@SubscribeMessage('point:delete')
async handlePointDelete(@ConnectedSocket() client: Socket, @MessageBody() data: { trip_id: string; point_id: string }) {
  await this.routePointsService.remove(data.trip_id, data.point_id)
  this.server.to(`trip_${data.trip_id}`).emit('point:deleted', { point_id: data.point_id })
}

// cursor:move — НЕ сохранять в БД, только broadcast
@SubscribeMessage('cursor:move')
handleCursor(@ConnectedSocket() client: Socket, @MessageBody() data: { trip_id: string; x: number; y: number }) {
  client.to(`trip_${data.trip_id}`).emit('cursor:moved', {
    user_id: client.data.userId,
    name: client.data.email,
    color: this.collabService.getUserColor(client.data.userId),
    x: data.x,
    y: data.y,
  })
}
```

**Проверка:** открыть 2 вкладки с одним tripId → добавить точку в одной → появляется в другой.

---

### TRI-15 — Шаг 1: Orchestrator
`branch: feature/TRI-15-backend-ai-orchestrator`

**Зависимости:**
```bash
cd apps/api && pnpm add openai
```

**Файлы создать:**
- `apps/api/src/ai/ai.module.ts`
- `apps/api/src/ai/ai.controller.ts`
- `apps/api/src/ai/pipeline/orchestrator.service.ts`
- `apps/api/src/ai/pipes/input-sanitizer.pipe.ts`
- `apps/api/src/ai/dto/ai-plan-request.dto.ts`

**`input-sanitizer.pipe.ts`:**
```ts
const INJECTION_PATTERNS = ['ignore previous', 'system:', '[INST]', '###', '<|']

@Injectable()
export class InputSanitizerPipe implements PipeTransform {
  transform(value: AiPlanRequestDto) {
    let query = value.user_query ?? ''
    query = query.slice(0, 1000)
    query = query.replace(/[\x00-\x1F\x7F]/g, '')
    query = query.replace(/[<>"'`]/g, '')
    for (const p of INJECTION_PATTERNS) {
      query = query.replace(new RegExp(p, 'gi'), '')
    }
    return { ...value, user_query: query.trim() }
  }
}
```

**`orchestrator.service.ts`:**
```ts
const SYSTEM_PROMPT = `You are a travel planning assistant. Parse the user's travel request into JSON.
Return ONLY valid JSON with this structure:
{
  "city": string,
  "days": number,
  "budget_rub": number | null,
  "party_type": "solo" | "couple" | "family" | "group",
  "categories": Array<"museum"|"park"|"restaurant"|"cafe"|"attraction"|"shopping"|"entertainment">,
  "excluded_categories": string[],
  "preferences_text": string,
  "radius_km": number
}`

@Injectable()
export class OrchestratorService {
  private openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  async parseIntent(query: string, history: Message[]): Promise<ParsedIntent> {
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      ...history.slice(-8).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: query },
    ]

    const intent = await this.callWithTimeout(messages, 20000)
    if (!intent.city) throw new UnprocessableEntityException('Could not parse city from request')
    return intent
  }

  private async callWithTimeout(messages: any[], timeoutMs: number, isRetry = false): Promise<ParsedIntent> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const resp = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: isRetry ? [...messages, { role: 'user' as const, content: 'Respond ONLY with valid JSON, no markdown' }] : messages,
        response_format: { type: 'json_object' },
        signal: controller.signal as any,
      })
      const content = resp.choices[0].message.content ?? '{}'
      return JSON.parse(content) as ParsedIntent
    } catch (e) {
      if (!isRetry) return this.callWithTimeout(messages, timeoutMs, true)
      throw new ServiceUnavailableException('AI orchestrator unavailable')
    } finally {
      clearTimeout(timer)
    }
  }
}
```

---

### TRI-16 — Шаг 2: YandexFetch
`branch: feature/TRI-16-backend-ai-yandex`

> **NOTE о Redis:** Код ниже содержит Redis-кэш (`this.redis.get/setex`).
> `RedisModule` создаётся в **TRI-19**, поэтому при реализации TRI-16 Redis-кэш нужно пропустить (закомментировать блоки с `this.redis`).
> После выполнения TRI-19 — раскомментировать.

**Файлы создать:**
- `apps/api/src/ai/pipeline/yandex-fetch.service.ts`

**Ключевая логика:**
```ts
@Injectable()
export class YandexFetchService {
  async fetchAndFilter(intent: ParsedIntent): Promise<PoiItem[]> {
    // Redis cache check (раскомментировать после TRI-19)
    // const cacheKey = this.getCacheKey(intent)
    // const cached = await this.redis.get(cacheKey)
    // if (cached) return JSON.parse(cached)
    const cacheKey = this.getCacheKey(intent)
    const cached = await this.redis?.get(cacheKey)
    if (cached) return JSON.parse(cached)

    // Параллельные запросы по категориям
    const results = await Promise.all(
      intent.categories.map(cat => this.fetchCategory(cat, intent))
    )
    let pois = results.flat()

    // Валидация координат
    pois = pois.filter(p => {
      const valid = isFinite(p.lat) && p.lat >= -90 && p.lat <= 90 &&
                    isFinite(p.lon) && p.lon >= -180 && p.lon <= 180
      if (!valid) console.warn(`Dropped POI with invalid coords: ${p.title}`)
      return valid
    })

    // Дедупликация (haversine < 0.05 км → оставить max rating)
    pois = this.deduplicate(pois)

    // Pre-filter: убрать excluded, sort by rating DESC, slice 15
    pois = pois
      .filter(p => !intent.excluded_categories.includes(p.category))
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, 15)

    // Retry если < 3 POI
    if (pois.length < 3) {
      const retry = await this.fetchWithRadius(intent, intent.radius_km * 1.3)
      if (retry.length < 3) throw new UnprocessableEntityException('Not enough POIs found (F-04)')
      pois = retry
    }

    // Redis cache set (TTL 24h) — раскомментировать после TRI-19
    await this.redis?.setex(cacheKey, 86400, JSON.stringify(pois))
    return pois
  }

  private async fetchCategory(category: string, intent: ParsedIntent): Promise<PoiItem[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const url = new URL('https://search-maps.yandex.ru/v1/')
      url.searchParams.set('text', `${category} ${intent.city}`)
      url.searchParams.set('type', 'biz')
      url.searchParams.set('lang', 'ru_RU')
      url.searchParams.set('results', '10')
      url.searchParams.set('apikey', process.env.YANDEX_MAPS_API_KEY!)
      url.searchParams.set('spn', `${intent.radius_km / 111},${intent.radius_km / 111}`)

      const resp = await fetch(url.toString(), { signal: controller.signal })
      const data = await resp.json()
      return (data.features ?? []).map((f: any) => this.normalize(f, category))
    } catch { return [] } finally { clearTimeout(timer) }
  }

  private normalize(feature: any, category: string): PoiItem {
    const [lon, lat] = feature.geometry?.coordinates ?? [0, 0]
    return {
      id: crypto.randomUUID(),
      title: feature.properties?.name ?? 'Unknown',
      address: feature.properties?.description ?? '',
      lat, lon,
      category: category as PoiCategory,
      rating: feature.properties?.rating ?? null,
      price_segment: feature.properties?.price_level ?? null,
    }
  }

  private getCacheKey(intent: ParsedIntent): string {
    const raw = `${intent.city}:${[...intent.categories].sort().join(',')}:${intent.radius_km}`
    return createHash('sha256').update(raw).digest('hex')
  }
}
```

---

### TRI-17 — Шаг 3: SemanticFilter
`branch: feature/TRI-17-backend-ai-filter`

**Файлы создать:**
- `apps/api/src/ai/pipeline/semantic-filter.service.ts`

```ts
@Injectable()
export class SemanticFilterService {
  async select(pois: PoiItem[], intent: ParsedIntent, fallbacks: string[]): Promise<FilteredPoi[]> {
    const prompt = `Выбери 5-10 самых подходящих мест для посещения.
Предпочтения: ${intent.preferences_text}
Тип группы: ${intent.party_type}
Бюджет: ${intent.budget_rub ?? 'не указан'} руб.

Список мест (JSON):
${JSON.stringify(pois.map(p => ({ id: p.id, title: p.title, category: p.category, rating: p.rating })))}

Верни JSON: { "selected": [{ "id": "...", "description": "1-2 предложения на русском" }] }`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)

    try {
      const resp = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
        method: 'POST',
        headers: {
          'Authorization': `Api-Key ${process.env.YANDEX_GPT_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          modelUri: `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt-lite`,
          completionOptions: { stream: false, temperature: 0.3, maxTokens: 2000 },
          messages: [{ role: 'user', text: prompt }],
        }),
        signal: controller.signal,
      })

      const data = await resp.json()
      const text = data.result?.alternatives?.[0]?.message?.text ?? '{}'
      const parsed: FilteredPoiResponse = JSON.parse(text.replace(/```json\n?|\n?```/g, ''))

      // Обогатить данными из оригинального массива
      return parsed.selected.map(s => {
        const original = pois.find(p => p.id === s.id)!
        return { ...original, description: s.description }
      })
    } catch (e) {
      // Fallback F-05: пропустить фильтрацию
      fallbacks.push('SEMANTIC_FILTER_SKIPPED')
      return pois.slice(0, 8).map(p => ({ ...p, description: '' }))
    } finally {
      clearTimeout(timer)
    }
  }
}
```

---

### TRI-18 — Шаг 4: Scheduler
`branch: feature/TRI-18-backend-ai-scheduler`

**Файлы создать:**
- `apps/api/src/ai/pipeline/scheduler.service.ts`

**`ai.controller.ts`** — полный оркестратор 4 шагов:
```ts
@Post('plan')
@UseGuards(JwtAuthGuard)
async plan(@Body(InputSanitizerPipe) dto: AiPlanRequestDto, @CurrentUser() user: { id: string }) {
  const timings: Record<string, number> = {}
  const fallbacks: string[] = []

  // Загрузить историю (max 10 сообщений)
  const session = await this.getOrCreateSession(dto.trip_id, user.id)
  const history = session.messages as Message[]

  const t0 = Date.now()
  const intent = await this.orchestrator.parseIntent(dto.user_query, history)
  timings.orchestrator = Date.now() - t0

  const t1 = Date.now()
  const rawPoi = await this.yandexFetch.fetchAndFilter(intent)
  timings.yandex_fetch = Date.now() - t1

  const t2 = Date.now()
  const filtered = await this.semanticFilter.select(rawPoi, intent, fallbacks)
  timings.semantic_filter = Date.now() - t2

  const t3 = Date.now()
  const plan = await this.scheduler.buildPlan(filtered, intent)
  timings.scheduler = Date.now() - t3

  // Сохранить сессию (max 10 сообщений)
  const newMessages = [
    ...history,
    { role: 'user', content: dto.user_query },
    { role: 'assistant', content: JSON.stringify(plan) },
  ].slice(-10)
  await this.saveSession(session.id, newMessages)

  return {
    session_id: session.id,
    route_plan: plan,
    meta: {
      steps_duration_ms: { ...timings, total: Object.values(timings).reduce((a, b) => a + b, 0) },
      poi_counts: { yandex_raw: rawPoi.length, after_semantic: filtered.length },
      fallbacks_triggered: fallbacks,
    },
  }
}
```

**`scheduler.service.ts`** — тайминги по категориям:
```ts
const VISIT_DURATION: Record<string, number> = {
  museum: 90, park: 60, restaurant: 60, cafe: 30,
  attraction: 60, shopping: 45, entertainment: 120,
}
```

**Проверка:** POST `/api/ai/plan` c `{ user_query: "2 дня в Казани, интересуюсь историей" }` → RoutePlan с ≥ 3 точками.

---

### TRI-19 — Кэширование в Redis
`branch: feature/TRI-19-backend-redis-cache`

> Redis уже используется в TRI-16 (YandexFetch). Эта задача — убедиться что RedisModule правильно настроен и `@Throttle` добавлен на AI контроллер.

**Файлы создать:**
- `apps/api/src/shared/redis/redis.module.ts`

```ts
import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'

export const REDIS = Symbol('REDIS')

@Global()
@Module({
  providers: [{
    provide: REDIS,
    inject: [ConfigService],
    useFactory: (cfg: ConfigService) => new Redis(cfg.get('REDIS_URL')!),
  }],
  exports: [REDIS],
})
export class RedisModule {}
```

**Throttle** на AI controller:
```bash
pnpm add @nestjs/throttler
```
```ts
// app.module.ts
ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }])

// ai.controller.ts
@Throttle({ default: { limit: 10, ttl: 60000 } })
```

**Проверка:** 11 запросов подряд → 429 Too Many Requests.

---

### TRI-20 — Live presence и курсоры
`branch: feature/TRI-20-backend-ws-presence`

> Presence уже реализована в TRI-13 (join/leave/disconnect).
> Эта задача — убедиться в полноте логики и добавить `@SubscribeMessage('cursor:move')` (из TRI-14).

**Итоговый чеклист:**
- [ ] `presence:join` → broadcast при join:trip (с userId, name, color)
- [ ] `presence:leave` → broadcast при leave:trip и disconnect
- [ ] `cursor:moved` → broadcast без сохранения в БД
- [ ] Presence Map очищается при disconnect

---

## FRONTEND (TRI-21 — TRI-40)

---

### TRI-21 — Структура FSD и Aliases [DONE]
`branch: feature/TRI-21-front-fsd-setup`

> **ВЫПОЛНЕНО** в предыдущей сессии:
> - FSD директории созданы (app, views, widgets, features, entities, shared)
> - `@/*` → `./src/*` в tsconfig.json
> - index.ts заглушки во всех слайсах

---

### TRI-22 — Tailwind CSS и shadcn/ui
`branch: feature/TRI-22-front-ui-system`

**Файлы изменить:**
- `apps/web/tailwind.config.ts` — добавить brand-токены
- `apps/web/src/app/globals.css` — убедиться что импорт tailwind есть

**`tailwind.config.ts`:**
```ts
import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          sky: '#0ea5e9',
          indigo: '#1e1b4b',
          amber: '#f59e0b',
          light: '#f0f9ff',
          bg: '#f0f6ff',
        },
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
    },
  },
}
export default config
```

**shadcn компоненты** (из `apps/web/`):
```bash
pnpm dlx shadcn@latest add card input dialog badge sheet dropdown-menu avatar
```

**Проверка:** `pnpm dev` — нет TS ошибок, brand-цвета применяются в className.

---

### TRI-23 — Shared утилиты
`branch: feature/TRI-23-front-shared-utils`

**Файлы создать:**
- `apps/web/src/shared/api/http.ts`
- `apps/web/src/shared/lib/yandex-maps.ts`
- `apps/web/src/shared/lib/haversine.ts`
- `apps/web/src/shared/lib/format-budget.ts`
- `apps/web/src/shared/config/env.ts`

**`http.ts`:**
```ts
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })

  if (res.status === 401) {
    localStorage.removeItem('accessToken')
    document.cookie = 'token=; path=/; max-age=0'
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message ?? `HTTP ${res.status}`)
  }

  return res.json()
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}
```

**`yandex-maps.ts`:**
```ts
let loadPromise: Promise<void> | null = null

export function loadYandexMaps(apiKey: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (loadPromise) return loadPromise

  loadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${apiKey}&lang=ru_RU`
    script.onload = () => (window as any).ymaps.ready(resolve)
    script.onerror = () => { loadPromise = null; reject(new Error('Failed to load Yandex Maps')) }
    document.head.appendChild(script)
  })

  return loadPromise
}
```

**`format-budget.ts`:**
```ts
export function formatBudget(amount: number): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(amount)
}
```

**`env.ts`:**
```ts
export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api',
  yandexMapsKey: process.env.NEXT_PUBLIC_YANDEX_MAPS_KEY ?? '',
}
```

---

### TRI-24 — UI Навигации
`branch: feature/TRI-24-front-layout`

**Файлы создать:**
- `apps/web/src/widgets/header/ui/Header.tsx`
- `apps/web/src/widgets/sidebar/ui/Sidebar.tsx`
- `apps/web/src/widgets/bottom-nav/ui/BottomNav.tsx`
- `apps/web/src/app/(main)/layout.tsx`

**`Sidebar.tsx`:**
```tsx
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Map, MessageSquare, User } from 'lucide-react'
import { cn } from '@/shared/lib/utils'

const NAV = [
  { href: '/', icon: Home, label: 'Главная' },
  { href: '/planner', icon: Map, label: 'Планировщик' },
  { href: '/ai-assistant', icon: MessageSquare, label: 'AI Ассистент' },
  { href: '/profile', icon: User, label: 'Профиль' },
]

export function Sidebar() {
  const pathname = usePathname()
  return (
    <aside className="fixed left-0 top-0 h-full w-16 bg-brand-indigo flex flex-col items-center py-6 gap-6 z-50">
      {NAV.map(({ href, icon: Icon, label }) => (
        <Link key={href} href={href} title={label}
          className={cn('p-3 rounded-xl text-white/60 hover:text-white hover:bg-white/10 transition-colors',
            pathname === href && 'text-white bg-white/20'
          )}>
          <Icon size={20} />
        </Link>
      ))}
    </aside>
  )
}
```

**`(main)/layout.tsx`:**
```tsx
import { Sidebar } from '@/widgets/sidebar/ui/Sidebar'
import { Header } from '@/widgets/header/ui/Header'

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 ml-16 flex flex-col">
        <Header />
        <main className="flex-1 overflow-auto bg-brand-bg">{children}</main>
      </div>
    </div>
  )
}
```

**`BottomNav.tsx`** — mobile, `fixed bottom-0`, `md:hidden`.

**Проверка:** sidebar отображается, active state по URL работает.

---

### TRI-25 — Zustand stores
`branch: feature/TRI-25-front-zustand`

**Зависимости:**
```bash
cd apps/web && pnpm add zustand
```

**Файлы создать:**
- `apps/web/src/entities/user/model/user.store.ts`
- `apps/web/src/entities/trip/model/trip.store.ts`
- `apps/web/src/features/auth/model/auth.store.ts`

**`user.store.ts`:**
```ts
import { create } from 'zustand'
import type { User } from '../model/user.types'

interface UserStore {
  user: User | null
  setUser: (u: User) => void
  clearUser: () => void
}

export const useUserStore = create<UserStore>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
  clearUser: () => set({ user: null }),
}))
```

**`trip.store.ts`:**
```ts
import { create } from 'zustand'
import type { Trip } from '../model/trip.types'
import type { RoutePoint } from '@/entities/route-point/model/route-point.types'

interface TripStore {
  currentTrip: Trip | null
  trips: Trip[]
  points: RoutePoint[]
  setCurrentTrip: (t: Trip) => void
  setTrips: (ts: Trip[]) => void
  addTrip: (t: Trip) => void
  setPoints: (ps: RoutePoint[]) => void
  addPoint: (p: RoutePoint) => void
  updatePoint: (id: string, data: Partial<RoutePoint>) => void
  removePoint: (id: string) => void
  reorderPoints: (orderedIds: string[]) => void
}

export const useTripStore = create<TripStore>((set, get) => ({
  currentTrip: null,
  trips: [],
  points: [],
  setCurrentTrip: (currentTrip) => set({ currentTrip }),
  setTrips: (trips) => set({ trips }),
  addTrip: (t) => set((s) => ({ trips: [t, ...s.trips] })),
  setPoints: (points) => set({ points }),
  addPoint: (p) => set((s) => ({ points: [...s.points, p] })),
  updatePoint: (id, data) => set((s) => ({
    points: s.points.map(p => p.id === id ? { ...p, ...data } : p)
  })),
  removePoint: (id) => set((s) => ({ points: s.points.filter(p => p.id !== id) })),
  reorderPoints: (orderedIds) => set((s) => ({
    points: orderedIds.map((id, i) => ({ ...s.points.find(p => p.id === id)!, order: i }))
  })),
}))
```

**`auth.store.ts`:**
```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthStore {
  isAuthenticated: boolean
  accessToken: string | null
  setAuth: (token: string) => void
  logout: () => void
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      accessToken: null,
      setAuth: (token) => {
        localStorage.setItem('accessToken', token)
        // Для SSR middleware
        document.cookie = `token=${token}; path=/; max-age=${7 * 24 * 3600}`
        set({ isAuthenticated: true, accessToken: token })
      },
      logout: () => {
        localStorage.removeItem('accessToken')
        document.cookie = 'token=; path=/; max-age=0'
        set({ isAuthenticated: false, accessToken: null })
        window.location.href = '/'
      },
    }),
    { name: 'auth-store' }
  )
)
```

---

### TRI-26 — LandingPage
`branch: feature/TRI-26-front-landing`

**Файлы создать:**
- `apps/web/src/views/landing/ui/LandingPage.tsx`
- `apps/web/src/app/(main)/page.tsx` — рендер `<LandingPage />`

**`LandingPage.tsx`** — секции:
1. **Hero** — fullscreen, фоновый градиент brand-indigo → brand-sky, поисковый input
2. **ManualSearchForm** — город, даты, бюджет
3. **PopularRoutes** — горизонтальный список TripCard'ов (predefined trips)
4. **FAQ** — shadcn Accordion

**Данные для Popular Routes:**
```ts
// при монтировании: api.get<Trip[]>('/trips/predefined')
useEffect(() => {
  api.get<Trip[]>('/trips/predefined').then(setTrips)
}, [])
```

**Проверка:** landing рендерится без ошибок, предзаданные маршруты загружаются.

---

### TRI-27 — Auth Модалки
`branch: feature/TRI-27-front-auth-modals`

**Зависимости:**
```bash
cd apps/web && pnpm add react-hook-form zod @hookform/resolvers
```

**Файлы создать:**
- `apps/web/src/features/auth/ui/LoginModal.tsx`
- `apps/web/src/features/auth/ui/RegisterModal.tsx`

**`LoginModal.tsx`:**
```tsx
const schema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
})

export function LoginModal({ onClose }: { onClose: () => void }) {
  const { register, handleSubmit, formState: { errors, isSubmitting }, setError } = useForm({
    resolver: zodResolver(schema)
  })
  const { setAuth } = useAuthStore()
  const { setUser } = useUserStore()

  const onSubmit = async (data: z.infer<typeof schema>) => {
    try {
      const { accessToken } = await api.post<{ accessToken: string }>('/auth/login', data)
      setAuth(accessToken)
      const user = await api.get<User>('/users/me')
      setUser(user)
      onClose()
    } catch (e: any) {
      setError('root', { message: e.message })
    }
  }
  // ... JSX с shadcn Dialog + Input + Button
}
```

**`middleware.ts`** (`apps/web/src/middleware.ts`):
```ts
import { NextRequest, NextResponse } from 'next/server'

const PROTECTED = ['/planner', '/ai-assistant', '/profile']

export function middleware(req: NextRequest) {
  const token = req.cookies.get('token')?.value
  const isProtected = PROTECTED.some(p => req.nextUrl.pathname.startsWith(p))
  if (isProtected && !token) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return NextResponse.next()
}

export const config = { matcher: ['/planner/:path*', '/ai-assistant/:path*', '/profile/:path*'] }
```

**Подводный камень:** middleware работает на сервере и видит только cookies, не localStorage.
Поэтому `setAuth()` пишет и в cookie и в localStorage одновременно.

**Проверка:** login → токен в cookie → `/planner` доступен без редиректа.

---

### TRI-28 — UI Списка точек
`branch: feature/TRI-28-front-route-list`

**Файлы создать:**
- `apps/web/src/widgets/route-builder/ui/RouteBuilder.tsx`
- `apps/web/src/widgets/route-builder/ui/PointRow.tsx`

**`PointRow.tsx`** — строка точки:
```tsx
interface PointRowProps {
  point: RoutePoint
  index: number
  onDelete: (id: string) => void
  onUpdate: (id: string, data: Partial<RoutePoint>) => void
  dragHandleProps?: DraggableAttributes & SyntheticListenerMap
}
```

**`RouteBuilder.tsx`** — таблица + бюджет:
```tsx
const totalBudget = points.reduce((sum, p) => sum + (p.budget ?? 0), 0)

// Заголовок с суммой бюджета
<div className="flex justify-between">
  <h2>Маршрут</h2>
  <span>{formatBudget(totalBudget)}</span>
</div>
```

**Загрузка точек при монтировании:**
```ts
useEffect(() => {
  if (!tripId) return
  api.get<RoutePoint[]>(`/trips/${tripId}/points`).then(setPoints)
}, [tripId])
```

---

### TRI-29 — Интеграция Яндекс Карт
`branch: feature/TRI-29-front-route-map`

**Файлы создать:**
- `apps/web/src/widgets/route-map/ui/RouteMap.tsx`

**`RouteMap.tsx`:**
```tsx
'use client'
import { useEffect, useRef } from 'react'
import { loadYandexMaps } from '@/shared/lib/yandex-maps'
import { env } from '@/shared/config/env'

interface RouteMapProps {
  points: RoutePoint[]
  onPointMove?: (id: string, lat: number, lon: number) => void
}

export function RouteMap({ points, onPointMove }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const polylineRef = useRef<any>(null)

  useEffect(() => {
    loadYandexMaps(env.yandexMapsKey).then(() => {
      const ymaps = (window as any).ymaps
      if (!mapRef.current) {
        mapRef.current = new ymaps.Map(containerRef.current, {
          center: [55.75, 37.57], zoom: 10,
        })
      }
      renderMarkers(ymaps)
    })
  }, [])

  // Перерисовать маркеры при изменении points
  useEffect(() => {
    if (!mapRef.current) return
    const ymaps = (window as any).ymaps
    if (!ymaps) return
    renderMarkers(ymaps)
  }, [points])

  function renderMarkers(ymaps: any) {
    const map = mapRef.current
    // Очистить старые
    markersRef.current.forEach(m => map.geoObjects.remove(m))
    if (polylineRef.current) map.geoObjects.remove(polylineRef.current)
    markersRef.current = []

    if (points.length === 0) return

    const coords: [number, number][] = []

    points.forEach((point, i) => {
      const coord: [number, number] = [point.lat, point.lon]
      coords.push(coord)

      const placemark = new ymaps.Placemark(coord,
        { iconContent: String(i + 1), balloonContent: point.title },
        { preset: 'islands#blueCircleIcon', draggable: !!onPointMove }
      )

      if (onPointMove) {
        placemark.events.add('dragend', () => {
          const newCoords = placemark.geometry.getCoordinates()
          onPointMove(point.id, newCoords[0], newCoords[1])
        })
      }

      map.geoObjects.add(placemark)
      markersRef.current.push(placemark)
    })

    // Polyline
    polylineRef.current = new ymaps.Polyline(coords, {}, {
      strokeColor: '#0ea5e9', strokeWidth: 3
    })
    map.geoObjects.add(polylineRef.current)

    // Auto-fit
    map.setBounds(ymaps.util.bounds.fromPoints(coords), { checkZoomRange: true, zoomMargin: 20 })
  }

  return <div ref={containerRef} className="w-full h-full rounded-2xl" />
}
```

**Проверка:** карта отображается, маркеры нумерованные, polyline соединяет их.

---

### TRI-30 — CRUD точек в UI
`branch: feature/TRI-30-front-route-crud`

**Файлы создать/изменить:**
- `apps/web/src/features/poi-search/ui/SearchDropdown.tsx`
- `apps/web/src/views/planner/ui/PlannerPage.tsx`

**`SearchDropdown.tsx`** — геокодинг через Yandex:
```tsx
// debounce 300ms на input
// Yandex geocoding: fetch(`https://geocode-maps.yandex.ru/1.x/?...&geocode=${query}`)
// Показать suggestions dropdown
// onSelect(suggestion) → callback с { title, lat, lon }
```

**Логика добавления точки в PlannerPage:**
```ts
const handleAddPoint = async (suggestion: { title: string; lat: number; lon: number }) => {
  const point = await api.post<RoutePoint>(`/trips/${tripId}/points`, {
    title: suggestion.title,
    lat: suggestion.lat,
    lon: suggestion.lon,
  })
  addPoint(point) // tripStore
}
```

**Удаление:**
```ts
const handleDelete = async (pointId: string) => {
  await api.del(`/trips/${tripId}/points/${pointId}`)
  removePoint(pointId) // tripStore
}
```

**Inline редактирование budget/visitDate:**
```ts
// debounce 500ms на PATCH /trips/:id/points/:pid
```

---

### TRI-31 — Drag & Drop
`branch: feature/TRI-31-front-route-dnd`

**Зависимости:**
```bash
cd apps/web && pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

**`RouteBuilder.tsx`** с dnd-kit:
```tsx
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'

function RouteBuilder({ tripId }: { tripId: string }) {
  const { points, reorderPoints } = useTripStore()
  const sensors = useSensors(useSensor(PointerSensor))

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIdx = points.findIndex(p => p.id === active.id)
    const newIdx = points.findIndex(p => p.id === over.id)
    const reordered = arrayMove(points, oldIdx, newIdx)
    reorderPoints(reordered.map(p => p.id)) // optimistic update

    await api.patch(`/trips/${tripId}/points/reorder`, {
      orderedIds: reordered.map(p => p.id)
    })
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={points.map(p => p.id)} strategy={verticalListSortingStrategy}>
        {points.map((point, i) => <PointRow key={point.id} point={point} index={i} />)}
      </SortableContext>
    </DndContext>
  )
}
```

**`PointRow.tsx`** — useSortable:
```tsx
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

function PointRow({ point, index }: PointRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: point.id })
  const style = { transform: CSS.Transform.toString(transform), transition }

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div {...listeners} className="cursor-grab p-2">⠿</div>
      {/* остальное */}
    </div>
  )
}
```

**Проверка:** drag точки → порядок меняется оптимистично → API вызов → карта перерисовывает polyline.

---

### TRI-32 — Chat интерфейс
`branch: feature/TRI-32-front-ai-chat-ui`

**Файлы создать:**
- `apps/web/src/widgets/ai-chat/ui/AiChat.tsx`
- `apps/web/src/widgets/ai-chat/ui/MessageBubble.tsx`

**`AiChat.tsx`:**
```tsx
const messagesEndRef = useRef<HTMLDivElement>(null)

// Scroll to bottom при новых сообщениях
useEffect(() => {
  messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
}, [messages])

// Quick actions
const QUICK_ACTIONS = ['Добавь ресторан', 'Сократи маршрут', 'Что посмотреть?', 'Смени город']
```

**Typing indicator при isLoading:**
```tsx
{isLoading && (
  <div className="flex gap-1 p-3 bg-white rounded-2xl w-16">
    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
  </div>
)}
```

**`MessageBubble.tsx`** — показать RoutePlan как карточки если `role === 'assistant'`:
```tsx
{message.routePlan && (
  <div className="flex flex-col gap-2 mt-2">
    {message.routePlan.days.flatMap(d => d.points).map(p => (
      <div key={p.poi_id} className="bg-white rounded-xl p-3 shadow-sm">
        <div className="font-medium">{p.title}</div>
        <div className="text-sm text-gray-500">{p.description}</div>
      </div>
    ))}
  </div>
)}
```

---

### TRI-33 — Интеграция API
`branch: feature/TRI-33-front-ai-integration`

**Файлы создать:**
- `apps/web/src/features/ai-query/model/ai-query.store.ts`

**`ai-query.store.ts`:**
```ts
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  routePlan?: RoutePlan
  timestamp: Date
}

interface AiQueryStore {
  messages: ChatMessage[]
  isLoading: boolean
  sessionId: string | null
  sendQuery: (query: string, tripId?: string) => Promise<void>
}

export const useAiQueryStore = create<AiQueryStore>((set, get) => ({
  messages: [],
  isLoading: false,
  sessionId: null,

  sendQuery: async (query, tripId) => {
    set(s => ({
      isLoading: true,
      messages: [...s.messages, { id: crypto.randomUUID(), role: 'user', content: query, timestamp: new Date() }]
    }))
    try {
      const resp = await api.post<AiPlanResponse>('/ai/plan', {
        user_query: query,
        trip_id: tripId,
        session_id: get().sessionId,
      })
      set(s => ({
        isLoading: false,
        sessionId: resp.session_id,
        messages: [...s.messages, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Составил план на ${resp.route_plan.days.length} дн.`,
          routePlan: resp.route_plan,
          timestamp: new Date(),
        }],
      }))
    } catch (e: any) {
      set(s => ({
        isLoading: false,
        messages: [...s.messages, {
          id: crypto.randomUUID(), role: 'assistant',
          content: `Ошибка: ${e.message}`, timestamp: new Date(),
        }],
      }))
    }
  },
}))
```

**Проверка:** ввести «2 дня в Казани» → ответ с карточками точек.

---

### TRI-34 — UI Виджета оптимизации
`branch: feature/TRI-34-front-opt-widget`

**Файлы создать:**
- `apps/web/src/widgets/compare-save/ui/CompareSave.tsx`
- `apps/web/src/features/route-optimize/model/optimize.store.ts`

**`optimize.store.ts`:**
```ts
interface OptimizeStore {
  transportMode: 'walk' | 'transit' | 'auto'
  params: { consumption: number; fuelPrice: number; tollFees: number }
  isOptimizing: boolean
  result: OptimizationResult | null
  setMode: (m: 'walk' | 'transit' | 'auto') => void
  setParams: (p: Partial<OptimizeStore['params']>) => void
  optimize: (tripId: string) => Promise<void>
}
```

**`CompareSave.tsx`:**
- Radio tabs: Пешком / Транспорт / Авто
- При `mode === 'auto'`: форма (расход л/100км, цена ₽/л)
- Кнопка «Оптимизировать маршрут»
- Таблица До/После (появляется после оптимизации):
  ```
  | Показатель | До | После | Экономия |
  | Расстояние | Xкм | Yкм | Zкм |
  | Топливо    | X₽ | Y₽  | Z₽  |
  | Время      | Xч | Yч  | Zч  |
  ```

---

### TRI-35 — Интеграция Оптимизации
`branch: feature/TRI-35-front-opt-integration`

**В `optimize.store.ts`** — метод `optimize()`:
```ts
optimize: async (tripId) => {
  set({ isOptimizing: true })
  const { transportMode, params } = get()
  try {
    const result = await api.post<OptimizationResult>(`/trips/${tripId}/optimize`, {
      transport_mode: transportMode,
      params: transportMode === 'auto' ? params : undefined,
    })
    set({ isOptimizing: false, result })
    // Обновить порядок точек в trip store
    useTripStore.getState().reorderPoints(result.optimizedOrder as string[])
  } catch (e) {
    set({ isOptimizing: false })
    throw e
  }
}
```

**Проверка:** нажать «Оптимизировать» → порядок точек в RouteBuilder изменился → карта перерисовалась → таблица показывает экономию.

---

### TRI-36 — Подключение Socket.io
`branch: feature/TRI-36-front-ws-client`

**Зависимости:**
```bash
cd apps/web && pnpm add socket.io-client
```

**Файлы создать:**
- `apps/web/src/shared/socket/socket-client.ts`

```ts
import { io, Socket } from 'socket.io-client'

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : ''
    socket = io((process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001') + '/collaboration', {
      auth: { token },
      transports: ['websocket'],
      autoConnect: true,
    })
    socket.on('connect_error', (err) => {
      console.error('WS connection error:', err.message)
    })
  }
  return socket
}

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
}
```

---

### TRI-37 — Синхронизация Zustand
`branch: feature/TRI-37-front-ws-sync`

**Файлы создать:**
- `apps/web/src/features/route-collaborate/model/collaborate.store.ts`
- `apps/web/src/features/route-collaborate/hooks/useCollaboration.ts`

**`collaborate.store.ts`:**
```ts
interface CollaborateStore {
  onlineUsers: { userId: string; name: string; color: string }[]
  cursors: Record<string, { x: number; y: number; name: string; color: string }>
  addUser: (u: { userId: string; name: string; color: string }) => void
  removeUser: (userId: string) => void
  updateCursor: (data: { user_id: string; x: number; y: number; name: string; color: string }) => void
}
```

**`useCollaboration.ts`:**
```ts
export function useCollaboration(tripId: string | null) {
  const tripStore = useTripStore()
  const collaborateStore = useCollaborateStore()

  useEffect(() => {
    if (!tripId) return
    const s = getSocket()

    s.emit('join:trip', { trip_id: tripId })

    // КРИТИЧНО: только обновляем store, НЕ вызываем API!
    s.on('point:added', ({ point }) => tripStore.addPoint(point))
    s.on('point:moved', ({ point_id, coords }) => tripStore.updatePoint(point_id, coords))
    s.on('point:deleted', ({ point_id }) => tripStore.removePoint(point_id))
    s.on('cursor:moved', (data) => collaborateStore.updateCursor(data))
    s.on('presence:join', (data) => collaborateStore.addUser(data))
    s.on('presence:leave', ({ user_id }) => collaborateStore.removeUser(user_id))

    return () => {
      s.emit('leave:trip', { trip_id: tripId })
      s.off('point:added')
      s.off('point:moved')
      s.off('point:deleted')
      s.off('cursor:moved')
      s.off('presence:join')
      s.off('presence:leave')
    }
  }, [tripId])
}
```

**Проверка:** открыть 2 вкладки с одним tripId → добавить точку через REST в одной → появляется в другой через WS без перезагрузки.

---

### TRI-38 — Live presence
`branch: feature/TRI-38-front-presence-ui`

**Файлы создать:**
- `apps/web/src/features/route-collaborate/ui/CollaboratorsList.tsx`
- `apps/web/src/features/route-collaborate/ui/LiveCursor.tsx`

**`CollaboratorsList.tsx`:**
```tsx
// Аватары онлайн-пользователей с цветовой обводкой
// Показывать в шапке PlannerPage
export function CollaboratorsList() {
  const { onlineUsers } = useCollaborateStore()
  return (
    <div className="flex -space-x-2">
      {onlineUsers.map(u => (
        <div key={u.userId} title={u.name}
          style={{ borderColor: u.color }}
          className="w-8 h-8 rounded-full border-2 bg-gray-200 flex items-center justify-center text-xs font-bold">
          {u.name[0].toUpperCase()}
        </div>
      ))}
    </div>
  )
}
```

**`LiveCursor.tsx`:**
```tsx
// Абсолютный div с именем пользователя
// position: fixed, pointer-events: none
// x * window.innerWidth, y * window.innerHeight
```

---

### TRI-39 — Анимации
`branch: feature/TRI-39-front-map-animations`

> Polyline анимация при изменении порядка точек.

**В `RouteMap.tsx`** — CSS transition на polyline:
```ts
// Yandex Maps не поддерживает CSS transitions напрямую.
// Вариант: при изменении points → fade out → обновить → fade in через opacity
polylineRef.current?.options.set('opacity', 0)
setTimeout(() => {
  renderMarkers(ymaps)
  polylineRef.current?.options.set('opacity', 1)
}, 300)
```

---

### TRI-40 — Мобильный интерфейс
`branch: feature/TRI-40-front-mobile-sheet`

**Файлы создать:**
- Draggable bottom sheet на `/recommendations`

**Использовать shadcn Sheet** компонент с side="bottom":
```tsx
import { Sheet, SheetContent, SheetHeader } from '@/shared/ui/sheet'
// или кастомный gesture с react-spring
```

**BottomNav** (`BottomNav.tsx`) — уже частично в TRI-24.

---

## ЗАВИСИМОСТИ МЕЖДУ ЗАДАЧАМИ

```
TRI-01 → TRI-02 → TRI-03 → TRI-04 → TRI-05 → TRI-06 (auth готов)
TRI-06 → TRI-07 → TRI-08 (trips и points API готовы)
TRI-08 → TRI-09 → TRI-10 → TRI-11 (TSP готов)
TRI-03 → TRI-12 → TRI-13 → TRI-14 (WebSockets готовы)
TRI-06 → TRI-15 → TRI-16 → TRI-17 → TRI-18 (AI pipeline готов)
TRI-16 → TRI-19 (Redis cache в YandexFetch)
TRI-13 → TRI-20 (Presence достроена)

TRI-21 [DONE] → TRI-22 → TRI-23 (shared layer готов)
TRI-23 → TRI-24 → TRI-25 (layout + stores готовы)
TRI-25 → TRI-26 → TRI-27 (auth flow готов)
TRI-27 → TRI-28 → TRI-29 → TRI-30 → TRI-31 (planner готов)
TRI-06 + TRI-25 → TRI-27 (логин требует backend auth)
TRI-08 + TRI-30 → TRI-31 (dnd reorder требует backend reorder)
TRI-18 + TRI-23 → TRI-32 → TRI-33 (AI чат требует backend AI)
TRI-11 + TRI-25 → TRI-34 → TRI-35 (оптимизация требует backend TSP)
TRI-14 + TRI-36 → TRI-37 (WS sync требует backend WS events)
TRI-37 → TRI-38 (presence UI требует WS sync)
```

## КАК Я СООБЩАЮ О ПРОГРЕССЕ

После завершения каждой задачи сообщаю:

> **Закрыл TRI-XX — [Название задачи]**
> Что сделано: [краткое описание]
> Проверка: [как убедиться]
>
> Следующая задача: TRI-YY

Пользователь ставит галочку в YouGile и мы переходим к следующей.
