'use client';

import { usePathname } from 'next/navigation';
import { Mail, Github, Map } from 'lucide-react';

const INTERNAL_PAGES = ['/planner', '/ai-assistant', '/profile', '/tours', '/recommendations'];

export function Footer() {
  const pathname = usePathname();
  const isLanding = pathname === '/';
  const isInternalPage = INTERNAL_PAGES.some((p) => pathname.startsWith(p));

  // Если это внутренняя страница на мобилке — скрываем подвал полностью (там BottomNav)
  // На десктопе внутренние страницы показывают подвал
  const footerClasses = `border-t border-slate-100 bg-white py-12 z-20 ${
    isInternalPage ? 'hidden md:block' : ''
  }`;

  return (
    <footer className={footerClasses}>
      <div className="max-w-5xl mx-auto px-4 md:px-6 flex flex-col md:flex-row justify-between items-center gap-8 w-full">
        <div className="flex items-center gap-3">
          <div className="bg-brand-indigo text-white p-2 rounded-xl">
            <Map size={24} />
          </div>
          <div className="flex flex-col text-left">
            <span className="font-bold text-xl text-brand-indigo leading-none">Tuda</span>
            <span className="text-[10px] text-slate-400 mt-2 font-medium leading-none uppercase tracking-widest">
              AI-powered trip planning
            </span>
          </div>
        </div>

        <div className="flex flex-col items-center md:items-start gap-3">
          <a
            href="mailto:feedback@tripai.com"
            className="flex items-center gap-2 !text-brand-indigo hover:!text-brand-blue transition-colors font-bold text-sm"
          >
            <Mail size={18} />
            feedback@tuda.pro
          </a>
          <a
            href="https://github.com/trip-plan-AI/travel-planner"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 !text-brand-indigo hover:!text-brand-blue transition-colors font-bold text-sm"
          >
            <Github size={18} />
            github.com/trip-plan-ai/tuda
          </a>
        </div>
      </div>
    </footer>
  );
}
