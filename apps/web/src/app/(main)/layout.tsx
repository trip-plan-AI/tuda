'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/widgets/sidebar/ui/Sidebar';
import { Header } from '@/widgets/header/ui/Header';
import { BottomNav } from '@/widgets/bottom-nav/ui/BottomNav';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLanding = pathname === '/';

  return (
    <div className="flex h-screen w-full">
      {!isLanding && <Sidebar />}
      <div className={`flex-1 flex flex-col min-w-0 ${!isLanding ? 'md:ml-20' : ''}`}>
        <Header />
        <main
          className={
            isLanding
              ? 'flex-1 overflow-auto bg-white'
              : 'flex-1 overflow-auto bg-brand-bg pb-16 md:pb-0'
          }
        >
          {children}
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
