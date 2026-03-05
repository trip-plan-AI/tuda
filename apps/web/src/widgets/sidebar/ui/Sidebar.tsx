'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Map, MessageSquare, User } from 'lucide-react'

import { cn } from '@/shared/lib/utils'

const NAV = [
  { href: '/',             icon: Home,          label: 'Главная'     },
  { href: '/planner',      icon: Map,           label: 'Маршруты'    },
  { href: '/ai-assistant', icon: MessageSquare, label: 'AI Ассистент'},
  { href: '/profile',      icon: User,          label: 'Профиль'     },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="hidden md:flex fixed left-0 top-0 h-full w-20 bg-white/95 backdrop-blur-md border-r border-slate-100 flex-col items-center pt-20 pb-6 gap-2 z-40">
      {NAV.map(({ href, icon: Icon, label }) => {
        const isActive = pathname === href
        return (
          <Link
            key={href}
            href={href}
            title={label}
            className={cn(
              'flex flex-col items-center justify-center w-14 h-14 rounded-2xl transition-all duration-150 text-slate-400 hover:bg-slate-50 hover:text-slate-600',
              isActive && 'bg-brand-sky/10 text-brand-sky',
            )}
          >
            <Icon size={24} strokeWidth={isActive ? 2.5 : 1.8} />
          </Link>
        )
      })}
    </aside>
  )
}
