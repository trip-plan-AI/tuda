import { api } from '@/shared/api'
import type { User } from '../model/user.types'

export interface UpdateUserPayload {
  name?: string
  photo?: string | null
}

export const usersApi = {
  getMe: () => api.get<User>('/users/me'),
  updateMe: (payload: UpdateUserPayload) => api.patch<User>('/users/me', payload),
}
