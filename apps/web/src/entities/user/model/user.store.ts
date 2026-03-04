import { create } from 'zustand'
import type { User } from './user.types'

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
