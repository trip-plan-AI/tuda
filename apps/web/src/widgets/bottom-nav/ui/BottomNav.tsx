'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Map, MessageSquare, User } from 'lucide-react'

import { cn } from '@/shared/lib/utils'

const NAV = [
  { href: '/', icon: Home, label: 'Главная' },
  { href: '/planner', icon: Map, label: 'Планировщик' },
  { href: '/ai-assistant', icon: MessageSquare, label: 'AI' },
  { href: '/profile', icon: User, label: 'Профиль' },
]

export function BottomNav() {
  const pathname = usePathname()

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-16 bg-white/95 backdrop-blur-xl border-t border-slate-100 flex items-center justify-around px-2 z-50 md:hidden">
      {NAV.map(({ href, icon: Icon, label }) => (
        <Link
          key={href}
          href={href}
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
  )
}
