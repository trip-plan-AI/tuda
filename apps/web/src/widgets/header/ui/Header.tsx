'use client';

import { useState, useEffect } from 'react';
import { Map, Home, MessageSquare, MapPin, User, LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

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
} from '@/shared/ui';
import { cn } from '@/shared/lib/utils';
import { useAuthStore } from '@/features/auth';
import { useUserStore } from '@/entities/user';
import { LoginModal } from '@/features/auth';
import { RegisterModal } from '@/features/auth';

type Modal = 'login' | 'register' | null;

const NAV_ITEMS = [
  {
    href: '/',
    icon: Home,
    label: 'Главная',
    activeClass: 'bg-brand-sky/10 text-brand-sky!',
    iconActive: 'bg-brand-sky text-white',
    iconIdle: 'bg-slate-100 text-slate-400',
  },
  {
    href: '/planner',
    icon: MapPin,
    label: 'Маршруты',
    activeClass: 'bg-brand-sky/10 text-brand-sky!',
    iconActive: 'bg-brand-sky text-white',
    iconIdle: 'bg-slate-100 text-slate-400',
  },
  {
    href: '/ai-assistant',
    icon: MessageSquare,
    label: 'AI Гид',
    activeClass: 'bg-brand-sky/10 text-brand-sky!',
    iconActive: 'bg-brand-sky text-white',
    iconIdle: 'bg-slate-100 text-slate-400',
  },
  {
    href: '/profile',
    icon: User,
    label: 'Личный кабинет',
    activeClass: 'bg-brand-sky/10 text-brand-sky!',
    iconActive: 'bg-brand-sky text-white',
    iconIdle: 'bg-slate-100 text-slate-400',
  },
];

export function Header() {
  const pathname = usePathname();
  const { isAuthenticated, logout } = useAuthStore();
  const { user } = useUserStore();
  const [modal, setModal] = useState<Modal>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // Zustand с persist загружает данные в микротасках, поэтому используем requestAnimationFrame
    requestAnimationFrame(() => {
      setHydrated(true);
    });
  }, []);

  return (
    <>
      <header className="sticky top-0 z-50 h-16 bg-white/95 backdrop-blur-md border-b border-slate-100 shrink-0 w-full flex justify-center">
        <div className="max-w-5xl px-4 md:px-6 h-full flex items-center justify-between w-full">
          {/* Логотип */}
          <Link href="/" className="flex items-center gap-3 transition-colors">
            <div className="bg-brand-sky text-white p-2 rounded-xl shadow-sm">
              <Map size={24} />
            </div>
            <span className="font-bold text-brand-indigo text-xl leading-none">Tuda</span>
          </Link>

          {/* Правая часть */}
          <div className="flex items-center gap-2">
            {!hydrated ? (
              <div className="w-10 h-10" />
            ) : isAuthenticated ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="lg"
                    className="h-10 w-10 rounded-full p-0 bg-slate-50 border border-slate-100 text-slate-500 hover:text-brand-indigo hover:bg-slate-100 transition-all shadow-sm focus-visible:ring-0 focus-visible:border-slate-100"
                  >
                    <Avatar size="lg" className="h-10 w-10">
                      <AvatarImage src={user?.photo ?? ''} />
                      <AvatarFallback className="bg-slate-50 text-slate-500">
                        <User size={28} strokeWidth={3} />
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>

                <DropdownMenuContent
                  align="end"
                  sideOffset={12}
                  className="w-64 bg-white rounded-[2rem] border border-slate-100 shadow-2xl z-[2000] py-4 px-2 animate-in fade-in slide-in-from-top-2"
                >
                  {/* Шапка профиля */}
                  <div className="px-4 py-3 border-b border-slate-50 mb-2">
                    <p className="text-xs font-black text-slate-400 uppercase tracking-widest">
                      Профиль
                    </p>
                    <p className="text-sm font-bold text-brand-indigo truncate">
                      {user?.name ?? 'Пользователь'}
                    </p>
                  </div>

                  <div className="space-y-1">
                    {NAV_ITEMS.map(
                      ({ href, icon: Icon, label, activeClass, iconActive, iconIdle }) => {
                        const isActive = pathname === href;
                        return (
                          <DropdownMenuItem
                            key={href}
                            asChild
                            noDefaultStyles
                            className="p-0! focus:bg-transparent! outline-none"
                          >
                            <Link
                              href={href}
                              className={cn(
                                'flex! w-full items-center gap-3 px-4! py-3! rounded-2xl text-sm font-bold transition-all no-underline! cursor-pointer',
                                isActive
                                  ? activeClass
                                  : 'text-slate-600! hover:bg-slate-50 hover:text-brand-indigo!',
                              )}
                            >
                              <div
                                className={cn(
                                  'p-2 rounded-xl transition-all duration-200 shrink-0',
                                  isActive ? iconActive : iconIdle,
                                )}
                              >
                                <Icon size={16} stroke={isActive ? '#fff' : 'currentColor'} />
                              </div>
                              {label}
                            </Link>
                          </DropdownMenuItem>
                        );
                      },
                    )}
                  </div>

                  <div className="mt-4 pt-2 border-t border-slate-50">
                    <DropdownMenuItem className="p-0! focus:bg-transparent! outline-none">
                      <button
                        onClick={logout}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-bold text-red-400 hover:bg-red-50 transition-all"
                      >
                        <div className="p-2 rounded-xl bg-red-50 text-red-400">
                          <LogOut size={16} />
                        </div>
                        Выйти
                      </button>
                    </DropdownMenuItem>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="default"
                  shape="2xl"
                  className="h-10 px-5 !text-brand-indigo"
                  onClick={() => setModal('login')}
                >
                  Войти
                </Button>
                <Button
                  variant="brand"
                  size="default"
                  shape="2xl"
                  className="h-10 px-5"
                  onClick={() => setModal('register')}
                >
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
  );
}
