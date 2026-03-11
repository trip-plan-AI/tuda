'use client';

import { useState, useEffect } from 'react';
import { Map, Home, MessageSquare, MapPin, User, LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import {
  Button,
  Avatar,
  AvatarImage,
  AvatarFallback,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui';
import { cn } from '@/shared/lib/utils';
import { useAuthStore } from '@/features/auth';
import { useUserStore } from '@/entities/user';
import { LoginModal } from '@/features/auth';
import { RegisterModal } from '@/features/auth';
import { api } from '@/shared/api';

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
  const router = useRouter();
  const pathname = usePathname();
  const isHome = pathname === '/';
  const { isAuthenticated, logout } = useAuthStore();
  const { user } = useUserStore();
  const [modal, setModal] = useState<Modal>(null);
  const [hydrated, setHydrated] = useState(false);
  const [isSessionExpiredModal, setIsSessionExpiredModal] = useState(false);

  useEffect(() => {
    // Zustand с persist загружает данные в микротасках, поэтому используем requestAnimationFrame
    requestAnimationFrame(() => {
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    const openLoginAfterSessionExpired = () => {
      if (typeof window === 'undefined') return;

      if (window.location.pathname === '/') {
        return;
      }

      const wasPrompted = sessionStorage.getItem('auth:session-expired-prompted') === '1';
      if (!wasPrompted) {
        toast.error('Срок сессии истёк. Войдите снова.');
        sessionStorage.setItem('auth:session-expired-prompted', '1');
      }

      setIsSessionExpiredModal(true);
      setModal('login');
    };

    if (
      typeof window !== 'undefined' &&
      window.location.pathname !== '/' &&
      sessionStorage.getItem('auth:session-expired') === '1'
    ) {
      openLoginAfterSessionExpired();
    }

    window.addEventListener('auth:session-expired', openLoginAfterSessionExpired);
    return () => {
      window.removeEventListener('auth:session-expired', openLoginAfterSessionExpired);
    };
  }, [pathname]);

  useEffect(() => {
    if (isAuthenticated && isSessionExpiredModal) {
      setIsSessionExpiredModal(false);
    }
  }, [isAuthenticated, isSessionExpiredModal]);

  const handleLoginModalClose = () => {
    setModal(null);

    const isLoggedInNow = useAuthStore.getState().isAuthenticated;

    if (isSessionExpiredModal && !isLoggedInNow) {
      setIsSessionExpiredModal(false);
      router.push('/');
    }
  };

  useEffect(() => {
    if (!hydrated || !isAuthenticated || pathname === '/') {
      return;
    }

    api.get('/users/me').catch(() => {
      // 401 обрабатывается централизованно в shared/api/http.ts
    });
  }, [hydrated, isAuthenticated, pathname]);

  return (
    <>
      <header
        className={cn(
          'sticky top-0 z-50 shrink-0 w-full',
          isHome
            ? 'block bg-black/20 backdrop-blur-xl border-b border-white/10'
            : 'hidden md:block bg-white border-b border-slate-200',
        )}
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="max-w-5xl mx-auto px-4 md:px-6 h-16 flex items-center justify-between w-full">
          {/* Логотип */}
          <Link href="/" className="flex items-center gap-3 transition-colors">
            <div className="bg-brand-sky text-white p-2 rounded-xl shadow-sm">
              <Map size={24} />
            </div>
            <span
              className={cn('font-bold text-xl leading-none', isHome ? 'text-white' : 'text-black')}
            >
              Tuda
            </span>
          </Link>

          {/* Правая часть */}
          <div className="flex items-center gap-2">
            {!hydrated ? (
              <div className="w-10 h-10" />
            ) : isAuthenticated ? (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="lg"
                    className={cn(
                      'h-10 w-10 rounded-full p-0 border transition-all shadow-sm focus-visible:ring-0',
                      isHome
                        ? 'bg-black/40 border-white/10 text-white hover:bg-black/60 hover:text-white'
                        : 'bg-slate-50 border-slate-100 text-slate-500 hover:text-brand-indigo hover:bg-slate-100 focus-visible:border-slate-100',
                    )}
                  >
                    <Avatar size="lg" className="h-10 w-10">
                      <AvatarImage src={user?.photo ?? ''} />
                      <AvatarFallback
                        className={cn(
                          'font-black text-sm tracking-wide',
                          isHome ? 'bg-grey/21 text-white' : 'bg-slate-100 text-brand-indigo',
                        )}
                      >
                        {user?.name
                          ? user.name.trim().slice(0, 2).toUpperCase()
                          : <User size={28} strokeWidth={3} />}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>

                <DropdownMenuContent
                  align="center"
                  sideOffset={12}
                  className={cn(
                    'w-64 rounded-[2rem] border shadow-2xl z-[2000] py-4 px-2 animate-in fade-in slide-in-from-top-2',
                    isHome
                      ? 'bg-black/20 backdrop-blur-xl border-white/10'
                      : 'bg-white border-slate-100',
                  )}
                >
                  {/* Шапка профиля */}
                  <div
                    className={cn(
                      'px-4 py-3 border-b mb-2',
                      isHome ? 'border-white/10' : 'border-slate-50',
                    )}
                  >
                    <p
                      className={cn(
                        'text-xs font-black uppercase tracking-widest',
                        isHome ? 'text-white/60' : 'text-slate-400',
                      )}
                    >
                      Профиль
                    </p>
                    <p
                      className={cn(
                        'text-sm font-bold truncate',
                        isHome ? 'text-white' : 'text-brand-indigo',
                      )}
                    >
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
                            className="p-0! outline-none"
                          >
                            <Link
                              href={href}
                              className={cn(
                                'flex! w-full items-center gap-3 px-4! py-3! rounded-2xl text-sm font-bold transition-all no-underline! cursor-pointer',
                                isActive
                                  ? activeClass
                                  : isHome
                                    ? 'text-white/80! hover:bg-white/10 hover:text-white!'
                                    : 'text-slate-600! hover:bg-slate-50 hover:text-brand-indigo!',
                              )}
                            >
                              <div
                                className={cn(
                                  'p-2 rounded-xl transition-all duration-200 shrink-0',
                                  isActive
                                    ? iconActive
                                    : isHome
                                      ? 'bg-white/10 text-white/60'
                                      : iconIdle,
                                )}
                              >
                                <Icon size={16} stroke={isActive || isHome ? '#fff' : 'currentColor'} />
                              </div>
                              {label}
                            </Link>
                          </DropdownMenuItem>
                        );
                      },
                    )}
                  </div>

                  <div
                    className={cn(
                      'mt-4 pt-2 border-t',
                      isHome ? 'border-white/10' : 'border-slate-50',
                    )}
                  >
                    <DropdownMenuItem className="p-0! focus:bg-transparent! outline-none">
                      <button
                        onClick={logout}
                        className={cn(
                          'w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-bold transition-all',
                          isHome
                            ? 'text-red-400 hover:bg-red-500/20'
                            : 'text-red-400 hover:bg-red-50',
                        )}
                      >
                        <div
                          className={cn(
                            'p-2 rounded-xl',
                            isHome ? 'bg-red-500/20 text-red-400' : 'bg-red-50 text-red-400',
                          )}
                        >
                          <LogOut size={16} stroke={isHome ? '#fff' : 'currentColor'} />
                        </div>
                        Выйти
                      </button>
                    </DropdownMenuItem>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div className="hidden md:flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="default"
                  shape="2xl"
                  className={cn(
                    'h-10 px-5',
                    isHome ? '!text-white' : '!text-slate-600 hover:!bg-slate-100',
                  )}
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
              </div>
            )}
          </div>
        </div>
      </header>

      <LoginModal
        open={modal === 'login'}
        onClose={handleLoginModalClose}
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
