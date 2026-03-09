'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Map, MessageSquare, User } from 'lucide-react'

import { cn } from '@/shared/lib/utils'
import { useAuthStore, LoginModal, RegisterModal } from '@/features/auth'

const NAV = [
  { href: '/', icon: Home, label: 'Главная' },
  { href: '/planner', icon: Map, label: 'Маршруты' },
  { href: '/ai-assistant', icon: MessageSquare, label: 'AI' },
  { href: '/profile', icon: User, label: 'Профиль' },
]

type Modal = 'login' | 'register' | null

export function BottomNav() {
  const pathname = usePathname()
  const isProfilePage = pathname.startsWith('/profile')
  const { isAuthenticated } = useAuthStore()
  const [modal, setModal] = useState<Modal>(null)

  const handleNavClick = (href: string, e: React.MouseEvent) => {
    if (href === '/profile' && !isAuthenticated) {
      e.preventDefault()
      setModal('login')
    }
  }

  return (
    <>
      <nav
        className={cn(
          'fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-xl flex items-center justify-around px-2 z-50 md:hidden',
          !isProfilePage && 'border-t border-slate-100',
        )}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)', minHeight: '4rem' }}
      >
        {NAV.map(({ href, icon: Icon, label }) => (
          <Link
            key={href}
            href={href}
            onClick={(e) => handleNavClick(href, e)}
            className={cn(
              'flex flex-col items-center gap-1 px-3 py-1.5 rounded-xl text-slate-400 hover:text-slate-600 transition-colors',
              pathname === href && 'bg-brand-sky/10 text-brand-sky font-bold',
            )}
          >
            <Icon size={20} />
            <span className="text-xs">{label}</span>
          </Link>
        ))}
      </nav>

      <LoginModal
        open={modal === 'login'}
        onClose={() => setModal(null)}
        onSwitchToRegister={() => setModal('register')}
      />
      <RegisterModal
        open={modal === 'register'}
        onClose={() => setModal(null)}
        onSwitchToLogin={() => setModal('login')}
      />
    </>
  )
}
