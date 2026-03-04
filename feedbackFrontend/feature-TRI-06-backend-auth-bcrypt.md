# TRI-06 — Хэширование пароля

## Описание задачи
Добавление bcrypt для хэширования паролей в auth.service.ts и создание users.service.ts.
Branch: `feature/TRI-06-backend-auth-bcrypt`

## Подход (из dev-guide.md)
- Зависимости: `bcrypt` + `@types/bcrypt`
- `auth.service.ts` — register с `bcrypt.hash(password, 10)`, login с `bcrypt.compare`
- `users.service.ts` — сервис для работы с пользователями

---

## Статус: ✅ Завершено (commit: fe401a7)

## Проверка реализации

### auth.service.ts ✅
- `register()` — хэширует пароль через `bcrypt.hash(dto.password, 10)`, вставляет в БД, возвращает accessToken
- `login()` — находит пользователя, проверяет пароль через `bcrypt.compare`, возвращает accessToken
- `validateUser()` — используется LocalStrategy (из TRI-04), корректно проверяет пароль
- `signToken()` — подписывает JWT с `{ sub: userId, email }`

### users.service.ts ✅
- `findById()` — возвращает пользователя без passwordHash
- `update()` — обновляет name/photo, возвращает без passwordHash (добавлен ранее при проверке TRI-04)

## Исправления
1. **ESLint `no-unused-vars` для `_`** — добавлено правило `varsIgnorePattern: '^_'` и `argsIgnorePattern: '^_'` в `apps/api/eslint.config.mjs`. Это стандартная практика для паттерна `const { passwordHash: _, ...result } = user`, который исключает поле из объекта.

## Ошибки
Других ошибок не найдено. Реализация полностью соответствует dev-guide.md.
