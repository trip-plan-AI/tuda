import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from './user.types'

interface UserStore {
  user: User | null
  geoDenied: boolean
  setUser: (u: User) => void
  clearUser: () => void
  setGeoDenied: (denied: boolean) => void
}

export const useUserStore = create<UserStore>()(
  persist(
    (set) => ({
      user: null,
      geoDenied: false,
      setUser: (user) => set({ user }),
      clearUser: () => set({ user: null }),
      setGeoDenied: (geoDenied) => set({ geoDenied }),
    }),
    { name: 'user-store' }
  )
)
