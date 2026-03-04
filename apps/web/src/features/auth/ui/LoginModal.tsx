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

const schema = z.object({
  email: z.string().email({ message: 'Введите корректный email' }),
  password: z.string().min(6, { message: 'Минимум 6 символов' }),
})

type FormData = z.infer<typeof schema>

interface LoginModalProps {
  open: boolean
  onClose: () => void
  onSwitchToRegister?: () => void
}

export function LoginModal({ open, onClose, onSwitchToRegister }: LoginModalProps) {
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
      const { accessToken } = await api.post<{ accessToken: string }>('/auth/login', data)
      setAuth(accessToken)
      const user = await api.get<User>('/users/me')
      setUser(user)
      reset()
      onClose()
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Ошибка входа'
      setError('root', { message })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl font-black text-brand-indigo">Вход в аккаунт</DialogTitle>
          <DialogDescription>Введите email и пароль для входа</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4 mt-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700" htmlFor="login-email">
              Email
            </label>
            <Input
              id="login-email"
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
            <label className="text-sm font-medium text-slate-700" htmlFor="login-password">
              Пароль
            </label>
            <Input
              id="login-password"
              type="password"
              placeholder="••••••"
              aria-invalid={!!errors.password}
              {...register('password')}
            />
            {errors.password && (
              <p className="text-xs text-destructive">{errors.password.message}</p>
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
            {isSubmitting ? 'Входим...' : 'Войти'}
          </Button>

          {onSwitchToRegister && (
            <p className="text-center text-sm text-slate-500">
              Нет аккаунта?{' '}
              <button
                type="button"
                className="text-brand-sky font-medium hover:underline"
                onClick={onSwitchToRegister}
              >
                Зарегистрироваться
              </button>
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}
