'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams, useRouter } from 'next/navigation';
import {
  Home,
  MapPin,
  MessageSquare,
  User,
  Map,
  Wallet,
  CheckSquare,
  Users,
} from 'lucide-react';

import { cn } from '@/shared/lib/utils';
import { useAuthStore, LoginModal, RegisterModal } from '@/features/auth';
import { useBudgetStore } from '@/views/planner/model/use-budget-store';

const NAV = [
  { href: '/', icon: Home, label: 'Главная' },
  { href: '/planner', icon: MapPin, label: 'Маршруты' },
  { href: '/ai-assistant', icon: MessageSquare, label: 'AI Ассистент' },
  { href: '/profile', icon: User, label: 'Профиль' },
];

const PLANNER_TABS = [
  { value: 'route', icon: Map, label: 'Маршрут' },
  { value: 'budget', icon: Wallet, label: 'Бюджет' },
  { value: 'todo', icon: CheckSquare, label: 'Todo' },
] as const;

type PlannerView = 'route' | 'budget' | 'todo';
type Modal = 'login' | 'register' | null;

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isAuthenticated } = useAuthStore();
  const [modal, setModal] = useState<Modal>(null);
  const { openExpenseModal } = useBudgetStore();

  const isLanding = pathname === '/';
  const isPlanner = pathname.startsWith('/planner');

  const currentView = (searchParams.get('view') as PlannerView) ?? 'budget';

  const handleNavClick = (href: string, e: React.MouseEvent) => {
    if (href === '/profile' && !isAuthenticated) {
      e.preventDefault();
      setModal('login');
    }
  };

  const handlePlannerTabClick = (value: PlannerView) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', value);
    router.push(`/planner?${params.toString()}`);
  };

  return (
    <>
      <aside
        className={cn(
          'hidden md:flex h-full backdrop-blur-md flex-col py-8 gap-4 shrink-0',
          'overflow-hidden border-r',
          'transition-[width,opacity,transform] duration-700 ease-[cubic-bezier(0.4,0,0.2,1)]',
          isLanding
            ? 'w-0 opacity-0 -translate-x-6 pointer-events-none border-transparent'
            : isPlanner
              ? 'w-52 opacity-100 translate-x-0 border-slate-200'
              : 'w-20 opacity-100 translate-x-0 border-slate-200',
        )}
      >
        {/* Main nav */}
        <div
          className={cn(
            'flex-1 flex flex-col gap-4 mt-0 min-w-0',
            isPlanner ? 'items-start px-4' : 'items-center pr-2',
          )}
        >
          {NAV.map(({ href, icon: Icon, label }) => {
            const isActive =
              href === '/planner' ? pathname.startsWith('/planner') : pathname === href;

            return (
              <div key={href} className="w-full">
                <Link
                  href={href}
                  title={label}
                  onClick={(e) => handleNavClick(href, e)}
                  className={cn(
                    'flex items-center gap-3 rounded-2xl transition-all relative group',
                    isPlanner ? 'px-3 py-2 w-full' : 'p-3',
                    isActive
                      ? 'bg-brand-sky text-white shadow-lg shadow-brand-sky/20'
                      : 'text-slate-400 hover:text-brand-indigo hover:bg-slate-50',
                  )}
                >
                  <Icon size={24} className={isActive ? 'stroke-white shrink-0' : 'shrink-0'} />
                  {isPlanner && (
                    <span
                      className={cn(
                        'text-sm font-semibold truncate',
                        isActive ? 'text-white' : '',
                      )}
                    >
                      {label}
                    </span>
                  )}
                </Link>

                {/* Planner sub-nav */}
                {isPlanner && href === '/planner' && (
                  <>
                    <hr className="border-slate-100 my-2" />
                    <div className="flex flex-col gap-1 pl-4">
                      {PLANNER_TABS.map(({ value, icon: TabIcon, label: tabLabel }) => {
                        const isTabActive = currentView === value;
                        return (
                          <button
                            key={value}
                            onClick={() => handlePlannerTabClick(value)}
                            className={cn(
                              'flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all w-full text-left',
                              isTabActive
                                ? 'bg-slate-900 text-white'
                                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50',
                            )}
                          >
                            <TabIcon size={16} className="shrink-0" />
                            {tabLabel}
                          </button>
                        );
                      })}
                    </div>
                    <hr className="border-slate-100 my-2" />
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Bottom section — visible when budget tab is active */}
        {isPlanner && currentView === 'budget' && (
          <div className="px-4 pb-2 flex flex-col gap-3">
            <button
              onClick={openExpenseModal}
              className="bg-amber-400/90 hover:bg-amber-400 text-white rounded-xl py-3 font-bold w-full mb-3 transition-colors text-sm"
            >
              + Добавить расход
            </button>

            <div className="bg-slate-50 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <Users size={16} className="text-slate-400" />
                <span className="text-xs font-bold text-slate-700">Планируй вместе</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Пригласи друзей и делите расходы вместе
              </p>
            </div>
          </div>
        )}
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
