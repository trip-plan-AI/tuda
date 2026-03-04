'use client'

import { usePathname } from 'next/navigation'
import { Mail, Github, Map } from 'lucide-react'

const INTERNAL_PAGES = ['/planner', '/ai-assistant', '/profile']

export function Footer() {
  const pathname = usePathname()
  const isInternalPage = INTERNAL_PAGES.some((p) => pathname.startsWith(p))

  if (isInternalPage) return null

  return (
    <footer className="border-t bg-background px-6 py-4 flex items-center justify-between">
      {/* Брендинг */}
      <div className="flex items-center gap-2">
        <div className="bg-brand-sky text-white p-1.5 rounded-lg">
          <Map size={16} />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="font-black text-brand-indigo text-sm">TripAI</span>
          <span className="text-xs text-slate-400 uppercase tracking-widest">
            AI-Powered Trip Planning
          </span>
        </div>
      </div>

      {/* Ссылки */}
      <div className="flex items-center gap-3">
        <a
          href="mailto:hello@tripai.ru"
          className="text-slate-400 hover:text-brand-indigo transition-colors"
          aria-label="Email"
        >
          <Mail size={18} />
        </a>
        <a
          href="https://github.com/trip-plan-AI"
          target="_blank"
          rel="noopener noreferrer"
          className="text-slate-400 hover:text-brand-indigo transition-colors"
          aria-label="GitHub"
        >
          <Github size={18} />
        </a>
      </div>
    </footer>
  )
}
