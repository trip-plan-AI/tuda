'use client'

import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Button } from '@/shared/ui/button'
import { api } from '@/shared/api'
import { useAuthStore } from '@/features/auth/model/auth.store'
import { useUserStore } from '@/entities/user'
import type { User } from '@/entities/user'

const schema = z
  .object({
    name: z.string().min(2, { message: 'Минимум 2 символа' }),
    email: z.string().email({ message: 'Введите корректный email' }),
    password: z.string().min(6, { message: 'Минимум 6 символов' }),
    confirmPassword: z.string(),
  })
  .check((ctx) => {
    if (ctx.value.password !== ctx.value.confirmPassword) {
      ctx.issues.push({
        code: 'custom',
        message: 'Пароли не совпадают',
        path: ['confirmPassword'],
        input: ctx.value.confirmPassword,
      })
    }
  })

type FormData = z.infer<typeof schema>

interface RegisterModalProps {
  open: boolean
  onClose: () => void
  onSwitchToLogin?: () => void
}

export function RegisterModal({ open, onClose, onSwitchToLogin }: RegisterModalProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
    reset,
  } = useForm<FormData>({ resolver: standardSchemaResolver(schema) })

  const { setAuth } = useAuthStore()
  const { setUser } = useUserStore()

  const onSubmit = async (data: FormData) => {
    try {
      const { accessToken } = await api.post<{ accessToken: string }>('/auth/register', {
        name: data.name,
        email: data.email,
        password: data.password,
      })
      setAuth(accessToken)
      const user = await api.get<User>('/users/me')
      setUser(user)
      reset()
      onClose()
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Ошибка регистрации'
      setError('root', { message })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl font-black text-brand-indigo">Регистрация</DialogTitle>
          <DialogDescription>Создайте аккаунт для планирования маршрутов</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4 mt-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700" htmlFor="reg-name">
              Имя
            </label>
            <Input
              id="reg-name"
              type="text"
              placeholder="Иван Иванов"
              aria-invalid={!!errors.name}
              {...register('name')}
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700" htmlFor="reg-email">
              Email
            </label>
            <Input
              id="reg-email"
              type="email"
              placeholder="example@mail.ru"
              aria-invalid={!!errors.email}
              {...register('email')}
            />
            {errors.email && (
              <p className="text-xs text-destructive">{errors.email.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700" htmlFor="reg-password">
              Пароль
            </label>
            <Input
              id="reg-password"
              type="password"
              placeholder="••••••"
              aria-invalid={!!errors.password}
              {...register('password')}
            />
            {errors.password && (
              <p className="text-xs text-destructive">{errors.password.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700" htmlFor="reg-confirm">
              Повторите пароль
            </label>
            <Input
              id="reg-confirm"
              type="password"
              placeholder="••••••"
              aria-invalid={!!errors.confirmPassword}
              {...register('confirmPassword')}
            />
            {errors.confirmPassword && (
              <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>
            )}
          </div>

          {errors.root && (
            <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
              {errors.root.message}
            </p>
          )}

          <Button
            type="submit"
            variant="brand"
            className="w-full mt-1"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Создаём аккаунт...' : 'Зарегистрироваться'}
          </Button>

          {onSwitchToLogin && (
            <p className="text-center text-sm text-slate-500">
              Уже есть аккаунт?{' '}
              <button
                type="button"
                className="text-brand-sky font-medium hover:underline"
                onClick={onSwitchToLogin}
              >
                Войти
              </button>
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}
