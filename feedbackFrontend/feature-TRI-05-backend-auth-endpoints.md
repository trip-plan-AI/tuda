# TRI-05 — Эндпоинты авторизации

## Описание задачи
Создание публичных эндпоинтов `/auth/register` и `/auth/login`.
Оба возвращают `{ accessToken: string }`. Guard не применяется.

## Подход (из dev-guide.md)
- `auth.controller.ts` — два @Post-метода без JwtAuthGuard
- `dto/create-user.dto.ts` — @IsEmail, @IsString, @MinLength(6)
- `dto/login.dto.ts` — @IsEmail, @IsString

---

## Статус: ✅ Завершено (commit: 1e9fda8)

## Проверка реализации

### auth.controller.ts ✅
- `@Controller('auth')` + два `@Post` без guard — соответствует требованиям
- Делегирует в `authService.register()` и `authService.login()`

### dto/create-user.dto.ts ✅
- `@IsEmail() email`
- `@IsString() @MinLength(6) password`
- `@IsString() name`

### dto/login.dto.ts ✅
- `@IsEmail() email`
- `@IsString() password`

## Ошибки
Ошибок не найдено. Реализация полностью соответствует требованиям dev-guide.md.
