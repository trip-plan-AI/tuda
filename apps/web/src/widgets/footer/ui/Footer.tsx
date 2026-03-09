'use client';

import { usePathname } from 'next/navigation';
import { Mail, Github, Map } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

const INTERNAL_PAGES = ['/planner', '/ai-assistant', '/profile', '/tours', '/recommendations'];

export function Footer() {
  const pathname = usePathname();
  const isLanding = pathname === '/';
  const isInternalPage = INTERNAL_PAGES.some((p) => pathname.startsWith(p));
  const isProfilePage = pathname.startsWith('/profile');

  // Скрываем подвал на мобилках во всем приложении (там BottomNav)
  // На десктопе показываем подвал
  const footerClasses = `${isProfilePage ? '' : 'border-t border-slate-100'} bg-white py-12 z-20 hidden md:block`;

  return (
    <footer className={footerClasses}>
      <div className="max-w-5xl mx-auto px-4 md:px-6 flex flex-col md:flex-row justify-between items-center gap-8 w-full">
        <div className="flex items-center gap-3">
          <div className="bg-brand-indigo text-white p-2 rounded-xl">
            <Map size={24} />
          </div>
          <div className="flex flex-col text-left">
            <span
              className={cn(
                'font-bold text-xl leading-none',
                isLanding ? 'text-brand-indigo' : 'text-white',
              )}
            >
              Tuda
            </span>
            <span className="text-[10px] text-slate-400 mt-2 font-medium leading-none uppercase tracking-widest">
              AI-powered trip planning
            </span>
          </div>
        </div>

        <div className="flex flex-col items-center md:items-start gap-3">
          <a
            href="mailto:feedback@tripai.com"
            className={cn(
              'flex items-center gap-2 hover:!text-brand-blue transition-colors font-bold text-sm',
              isLanding ? '!text-brand-indigo' : '!text-white',
            )}
          >
            <Mail size={18} />
            feedback@tuda.pro
          </a>
          <a
            href="https://github.com/trip-plan-AI/travel-planner"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'flex items-center gap-2 hover:!text-brand-blue transition-colors font-bold text-sm',
              isLanding ? '!text-brand-indigo' : '!text-white',
            )}
          >
            <Github size={18} />
            github.com/trip-plan-ai/tuda
          </a>
        </div>
      </div>
    </footer>
  );
}
