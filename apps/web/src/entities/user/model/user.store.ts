import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from './user.types'

interface UserStore {
  user: User | null
  setUser: (u: User) => void
  clearUser: () => void
}

export const useUserStore = create<UserStore>()(
  persist(
    (set) => ({
      user: null,
      setUser: (user) => set({ user }),
      clearUser: () => set({ user: null }),
    }),
    { name: 'user-store' }
  )
)
