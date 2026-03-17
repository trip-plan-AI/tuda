# Fix: Geosearch 500 Error — TRI-114

## Проблема

При вводе названия города в инпуты ручного поиска маршрутов (на главной странице и в планнере) возникала ошибка:

```
Failed to load resource: the server responded with a status of 500 (Internal Server Error)
Failed to fetch suggestions: Error: Suggest request failed: 500
```

## Причина

После рефакторинга TRI-118 (коммит e4f9b1c) код был перемещён из `PlannerPage.tsx` в:
- `use-planner.ts` — хук состояния и логики
- `ConstructorTab.tsx` — JSX конструктора
- `route-utils.ts` — утилиты

В процессе рефакторинга была утеряна проверка `res.ok` в функции `geocode()`, что приводило к попытке парсинга JSON из error response и последующей ошибке.

Дополнительно найдена проблема в `geosearch.service.ts`:
- Использование `item.uri.match()` без проверки на `undefined`
- Вызывало `TypeError: Cannot read property 'match' of undefined`
- Приводило к 500 ошибке при обработке результатов без `uri` поля

## Решение

### 1. Frontend: Восстановлена обработка ошибок в PlannerPage

**Файл:** `apps/web/src/views/planner/model/use-planner.ts`

```typescript
const geocode = useCallback(async (query: string) => {
  // ...
  try {
    const url = `${env.apiUrl}/geosearch/suggest?q=${encodeURIComponent(query)}${locSuffix}`;
    const res = await fetch(url);

    // ✅ Добавлена проверка HTTP статуса
    if (!res.ok) {
      console.error(`[Geosearch] HTTP ${res.status}: ${res.statusText}`);
      throw new Error(`Suggest request failed: ${res.status}`);
    }

    const data = await res.json();
    const found = filterUniqueSuggestions(data.results ?? []);
    setSuggestions(found);
    setShowDropdown(true);
  } catch (e) {
    console.error('[Geosearch] Failed to fetch suggestions:', e);
    setSuggestions([]);
    setShowDropdown(false); // ✅ Закрываем dropdown при ошибке
  } finally {
    setIsSearching(false);
  }
}, []);
```

### 2. Backend: Добавлен глобальный HTTP exception filter

**Файл:** `apps/api/src/http-exception.filter.ts` (новый)

```typescript
import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllHttpExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    // Логируем только 5xx ошибки
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} - ${status}: ${exception}`,
      );
    }

    response.status(status).json({ /* ... */ });
  }
}
```

**Файл:** `apps/api/src/main.ts`

```typescript
import { AllHttpExceptionsFilter } from './http-exception.filter';

const app = await NestFactory.create(AppModule);
app.useGlobalFilters(new AllHttpExceptionsFilter());
// ...
```

### 3. Backend: Исправлен crash в geosearch dedup logic

**Файл:** `apps/api/src/geosearch/geosearch.service.ts`

```typescript
// ❌ БЫЛО:
const coordDeduped = allScored.filter((item) => {
  const match = item.uri.match(/ll=([^&]+)/); // Может упасть если uri === undefined
  // ...
});

// ✅ СТАЛО:
const coordDeduped = allScored.filter((item) => {
  const match = item.uri?.match(/ll=([^&]+)/); // Optional chaining
  // ...
});
```

Исправлено 2 места:
- Строка 231: `suggestInternalWithBbox()`
- Строка 422: `suggestInternal()`

## Коммиты

```
a2118e0 fix(TRI-114): restore geosearch error handling in PlannerPage
60be9f8 fix(api): add global HTTP exception filter for better error logging
9fea54a fix(api): prevent crashes in geosearch dedup logic
```

## Тестирование

1. Запустить API: `npm run dev:api`
2. Запустить frontend: `npm run dev:web`
3. Проверить ввод в инпутах:
   - **LandingPage**: `/` → режим "Вручную" → ввод "москва", "сочи", "спб"
   - **PlannerPage**: `/planner` → ввод в поиске мест
4. Ожидается:
   - ✅ Подсказки отображаются
   - ✅ При 500 ошибке — логирование в консоль, dropdown закрывается
   - ✅ Нет crashей с "Cannot read property 'match' of undefined"

## Связанные задачи

- TRI-114: Route covers
- TRI-118: Planner page FSD refactor
- TRI-115: Bug fixes

## Примечания

- `LandingPage.tsx` уже имел правильную обработку ошибок (коммит 7300e946)
- Проблема была только в `PlannerPage` → `use-planner.ts`
- Redis недоступен — не является проблемой, сервис gracefully деградирует
