'use client';

import { usePathname } from 'next/navigation';
import { Header } from '@/widgets/header/ui/Header';
import { BottomNav } from '@/widgets/bottom-nav/ui/BottomNav';
import { Footer } from '@/widgets/footer';
import { PersistentMapShell } from '@/widgets/persistent-map-shell';
import { MobileContentSheet } from '@/widgets/mobile-content-sheet';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLanding = pathname === '/';
  const isProfile = pathname.startsWith('/profile');

  // Profile page: uses standard window scroll with sticky sidebars (no MobileContentSheet)
  if (isProfile) {
    return (
      <div className="bg-white min-h-screen w-full flex flex-col relative">
        <Header />
        <div className="flex flex-1 w-full pt-0 relative">
          {/* Mobile: no map, just content */}
          <div className="md:hidden flex w-full">
            <main className="w-full flex flex-col min-w-0 pb-16">{children}</main>
          </div>

          {/* Desktop: Grid with Sticky Map and Sidebar */}
          <div
            className="hidden md:grid w-full"
            style={{ gridTemplateColumns: '80px minmax(0, 1fr) minmax(0, 1fr)' }}
          >
            <div className="sticky top-16 h-[calc(100vh-64px)] z-40 self-start">
              <Sidebar />
            </div>
            <main
              className="min-w-0 bg-white pb-16 md:pb-0 flex flex-col"
              data-testid="desktop-profile-pane"
            >
              {children}
            </main>
            <aside className="min-w-0 border-l border-slate-200 bg-slate-50 h-[calc(100vh-64px)] sticky top-16 self-start">
              <PersistentMapShell />
            </aside>
          </div>
        </div>
        <div className="md:hidden shrink-0 fixed bottom-0 left-0 right-0 z-50">
          <BottomNav />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white min-h-screen w-full flex flex-col">
      {isLanding ? (
        <>
          <div className="relative flex flex-col w-full">
            <div className="fixed top-0 left-0 right-0 z-50">
              <Header />
            </div>
            <div className="flex flex-1 w-full">
              <main className="flex-1 bg-white min-w-0 pb-16 md:pb-0">{children}</main>
            </div>
          </div>
          <Footer />
          <BottomNav />
        </>
      ) : (
        <>
          <Header />
          <div className="flex flex-1 w-full pt-0 relative">
            <div className="md:hidden absolute inset-0 z-0" data-testid="mobile-map-layer">
              <PersistentMapShell />
            </div>

            <div className="md:hidden relative z-10 flex w-full">
              <MobileContentSheet>{children}</MobileContentSheet>
            </div>

            <div
              className="hidden md:grid w-full"
              style={{ gridTemplateColumns: '80px minmax(0, 1fr) minmax(0, 1fr)' }}
            >
              {/* Sidebar Wrapper for Sticky Positioning */}
              <div className="sticky top-16 h-[calc(100vh-64px)] z-40 self-start">
                <Sidebar />
              </div>

              {/* Main Scrolling Content */}
              <main className="min-w-0 bg-white pb-16 md:pb-0" data-testid="desktop-content-pane">
                {children}
              </main>

              {/* Sticky Map Aside */}
              <aside
                className="min-w-0 border-l border-slate-200 bg-slate-50 h-[calc(100vh-64px)] sticky top-16 self-start"
                data-testid="desktop-map-pane"
              >
                <PersistentMapShell />
              </aside>
            </div>
          </div>
          <Footer />
          <BottomNav />
        </>
      )}
    </div>
  );
}
