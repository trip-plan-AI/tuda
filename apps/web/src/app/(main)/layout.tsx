'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/widgets/sidebar/ui/Sidebar';
import { Header } from '@/widgets/header/ui/Header';
import { BottomNav } from '@/widgets/bottom-nav/ui/BottomNav';
import { Footer } from '@/widgets/footer';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLanding = pathname === '/';

  return (
    <div className="bg-white min-h-screen">
      <Header />
      <div className="flex justify-center w-full pt-0">
        <div className={isLanding ? 'flex w-full' : 'flex w-full max-w-[1104px]'}>
          {!isLanding && <Sidebar />}
          <main
            className={
              isLanding
                ? 'flex-1 overflow-auto bg-white'
                : 'flex-1 flex flex-col relative w-full min-w-0 bg-white max-w-5xl min-h-screen'
            }
          >
            {children}
          </main>
        </div>
      </div>
      <Footer />
      <BottomNav />
    </div>
  );
}
