'use client'

import { useState } from 'react'
import { Map, Home, MessageSquare, MapPin, User, LogOut } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import {
  Button,
  Avatar,
  AvatarImage,
  AvatarFallback,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { useAuthStore } from '@/features/auth'
import { useUserStore } from '@/entities/user'
import { LoginModal } from '@/features/auth'
import { RegisterModal } from '@/features/auth'

type Modal = 'login' | 'register' | null

const NAV_ITEMS = [
  { href: '/',             icon: Home,          label: 'Главная',        activeClass: 'bg-brand-sky/10 text-brand-sky',  iconActive: 'bg-brand-sky text-white',  iconIdle: 'bg-slate-100 text-slate-400 group-hover:bg-brand-sky/20 group-hover:text-brand-sky' },
  { href: '/ai-assistant', icon: MessageSquare, label: 'AI Гид',         activeClass: 'bg-purple-50 text-purple-600',    iconActive: 'bg-purple-600 text-white', iconIdle: 'bg-purple-100 text-purple-400 group-hover:bg-purple-600 group-hover:text-white' },
  { href: '/planner',      icon: MapPin,        label: 'Маршруты',       activeClass: 'bg-brand-sky/10 text-brand-sky',  iconActive: 'bg-brand-sky text-white',  iconIdle: 'bg-slate-100 text-slate-400 group-hover:bg-brand-sky/20 group-hover:text-brand-sky' },
  { href: '/profile',      icon: User,          label: 'Личный кабинет', activeClass: 'bg-brand-sky/10 text-brand-sky',  iconActive: 'bg-brand-sky text-white',  iconIdle: 'bg-slate-100 text-slate-400 group-hover:bg-brand-sky/20 group-hover:text-brand-sky' },
]

export function Header() {
  const pathname = usePathname()
  const { isAuthenticated, logout } = useAuthStore()
  const { user } = useUserStore()
  const [modal, setModal] = useState<Modal>(null)

  return (
    <>
      <header className="sticky top-0 z-50 h-16 bg-white/95 backdrop-blur-md border-b border-slate-100 shrink-0">
        <div className="max-w-7xl mx-auto px-8 h-full flex items-center relative">

          {/* Логотип */}
          <Link
            href="/"
            className="absolute left-[31%] -translate-x-1/2 flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <div className="bg-brand-sky text-white p-1.5 rounded-[2px] shadow-sm">
              <Map size={22} strokeWidth={1.5} />
            </div>
            <span className="font-bold text-brand-indigo text-lg tracking-tight">TripAI</span>
          </Link>

          {/* Правая часть */}
          <div className="absolute right-[14.5%] flex items-center gap-2">
            {isAuthenticated ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="lg"
                    className="h-10 w-10 rounded-full p-0 border border-slate-200 hover:bg-slate-50 transition-all shadow-sm focus-visible:ring-0"
                  >
                    <Avatar size="lg" className="h-10 w-10">
                      <AvatarImage src={user?.photo ?? ''} />
                      <AvatarFallback className="bg-slate-50 text-slate-400">
                        <User size={18} />
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>

                <DropdownMenuContent
                  align="center"
                  sideOffset={14}
                  className="w-80! rounded-4xl! pt-7! pb-6! px-0! shadow-[0_24px_60px_rgba(0,0,0,0.12)] border-slate-100 bg-white z-100"
                >
                  {/* Шапка профиля */}
                  <div className="px-7 pb-5">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] leading-none mb-3">
                      Профиль
                    </p>
                    <p className="text-[16px] font-bold text-brand-indigo truncate">
                      {user?.name ?? 'Пользователь'}
                    </p>
                  </div>

                  <DropdownMenuSeparator className="mx-6! my-4! bg-slate-100" />

                  <div className="flex flex-col gap-2.5 px-3">
                    {NAV_ITEMS.map(({ href, icon: Icon, label, activeClass, iconActive, iconIdle }) => {
                      const isActive = pathname === href
                      return (
                        <DropdownMenuItem
                          key={href}
                          asChild
                          className="p-0! focus:bg-transparent! outline-none"
                        >
                          <Link
                            href={href}
                            className={cn(
                              'flex items-center gap-4 px-4 py-3.5 rounded-2xl transition-all duration-200 group cursor-pointer',
                              isActive ? activeClass : 'text-slate-600 hover:bg-brand-light',
                            )}
                          >
                            <div className={cn('p-2 rounded-xl transition-all duration-200 shrink-0', isActive ? iconActive : iconIdle)}>
                              <Icon size={18} />
                            </div>
                            <span className="font-medium text-[16px] leading-none">{label}</span>
                          </Link>
                        </DropdownMenuItem>
                      )
                    })}
                  </div>

                  <DropdownMenuSeparator className="mx-6! my-4! bg-slate-100" />

                  <div className="px-3">
                    <DropdownMenuItem className="p-0! focus:bg-transparent! outline-none">
                      <button
                        onClick={logout}
                        className="flex items-center w-full gap-4 px-4 py-3.5 rounded-2xl text-red-500 hover:bg-red-50 transition-all duration-200 group cursor-pointer"
                      >
                        <div className="p-2 rounded-xl bg-red-50 text-red-500 group-hover:bg-red-500 group-hover:text-white transition-all duration-200 shrink-0">
                          <LogOut size={18} />
                        </div>
                        <span className="font-bold text-[16px] leading-none">Выйти</span>
                      </button>
                    </DropdownMenuItem>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={() => setModal('login')}>
                  Войти
                </Button>
                <Button variant="brand" size="sm" onClick={() => setModal('register')}>
                  Регистрация
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

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
