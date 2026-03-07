'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { MapPin, MessageSquare, User, Home } from 'lucide-react';

import { cn } from '@/shared/lib/utils';
import { useAuthStore, LoginModal, RegisterModal } from '@/features/auth';

const NAV = [
  { href: '/', icon: Home, label: 'Главная' },
  { href: '/planner', icon: MapPin, label: 'Маршруты' },
  { href: '/ai-assistant', icon: MessageSquare, label: 'AI Ассистент' },
  { href: '/profile', icon: User, label: 'Профиль' },
];

type Modal = 'login' | 'register' | null;

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated } = useAuthStore();
  const [modal, setModal] = useState<Modal>(null);

  const handleNavClick = (href: string, e: React.MouseEvent) => {
    if (href === '/profile' && !isAuthenticated) {
      e.preventDefault();
      setModal('login');
    }
  };

  return (
    <>
      <aside className="hidden md:flex sticky top-16 h-[calc(100vh-64px)] w-20 backdrop-blur-md flex-col items-center py-8 gap-4 shrink-0 z-40">
        <div className="flex-1 flex flex-col gap-4 items-center mt-0">
          {NAV.map(({ href, icon: Icon, label }) => {
            const isActive = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                title={label}
                onClick={(e) => handleNavClick(href, e)}
                className={cn(
                  'p-3 rounded-2xl transition-all relative group',
                  isActive
                    ? 'bg-brand-sky text-white shadow-lg shadow-brand-sky/20'
                    : 'text-slate-400 hover:text-brand-indigo hover:bg-slate-50',
                )}
              >
                <Icon size={24} className={isActive ? 'stroke-white' : ''} />
              </Link>
            );
          })}
        </div>
      </aside>

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
