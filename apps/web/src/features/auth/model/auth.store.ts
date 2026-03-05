import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useUserStore } from '@/entities/user'

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
        document.cookie = `token=${token}; path=/; max-age=${7 * 24 * 3600}`
        set({ isAuthenticated: true, accessToken: token })
      },
      logout: () => {
        localStorage.removeItem('accessToken')
        document.cookie = 'token=; path=/; max-age=0'
        useUserStore.getState().clearUser()
        set({ isAuthenticated: false, accessToken: null })
        window.location.href = '/'
      },
    }),
    { name: 'auth-store' }
  )
)
