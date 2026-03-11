'use client';

import { Mail, Github, Map } from 'lucide-react';

export function Footer() {
  return (
    <footer className="bg-[#2f2f2f] py-12 z-20 hidden md:block">
      <div className="max-w-5xl mx-auto px-4 md:px-6 flex flex-col md:flex-row justify-between items-center gap-8 w-full">
        <div className="flex items-center gap-3">
          <div className="bg-white/10 text-white p-2 rounded-xl">
            <Map size={24} />
          </div>
          <div className="flex flex-col text-left">
            <span className="font-bold text-xl leading-none text-white">
              Tuda
            </span>
            <span className="text-[10px] text-white/50 mt-2 font-medium leading-none uppercase tracking-widest">
              AI-powered trip planning
            </span>
          </div>
        </div>

        <div className="flex flex-col items-center md:items-start gap-3">
          <a
            href="mailto:feedback@tripai.com"
            className="flex items-center gap-2 text-white! font-bold text-sm hover:text-brand-sky! transition-colors"
          >
            <Mail size={18} />
            feedback@tuda.pro
          </a>
          <a
            href="https://github.com/trip-plan-AI/travel-planner"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-white! font-bold text-sm hover:text-brand-sky! transition-colors"
          >
            <Github size={18} />
            github.com/trip-plan-ai/tuda
          </a>
        </div>
      </div>
    </footer>
  );
}
