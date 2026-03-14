'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/widgets/sidebar/ui/Sidebar';
import { Header } from '@/widgets/header/ui/Header';
import { BottomNav } from '@/widgets/bottom-nav/ui/BottomNav';
import { Footer } from '@/widgets/footer';
import { PersistentMapShell } from '@/widgets/persistent-map-shell';
import { MobileContentSheet } from '@/widgets/mobile-content-sheet';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLanding = pathname === '/';

  return (
    <div className="bg-white min-h-[112vh] w-full flex flex-col" style={{zoom: 0}}>
      {isLanding ? (
        <>
          <div className="relative">
            <div className="absolute top-0 left-0 right-0 z-50">
              <Header />
            </div>
            <div className="flex flex-1 w-full">
              <div className="flex w-full">
                <Sidebar />
                <main className="flex-1 bg-white min-w-0 pb-16 md:pb-0">
                  {children}
                </main>
              </div>
            </div>
          </div>
          <Footer />
          <BottomNav />
        </>
      ) : (
        <>
          <div className="hidden md:block">
            <Header />
          </div>
          <div className="flex flex-1 w-full pt-0 relative">
            <div className="md:hidden absolute inset-0 z-0" data-testid="mobile-map-layer">
              <PersistentMapShell />
            </div>

            <div className="md:hidden relative z-10 flex w-full">
              <MobileContentSheet>{children}</MobileContentSheet>
            </div>

            <div className="hidden md:flex w-full">
              <Sidebar />
              <div className="flex w-full min-w-0">
                <main
                  className="w-1/2 min-w-0 overflow-y-auto bg-white pb-16 md:pb-0"
                  data-testid="desktop-content-pane"
                >
                  {children}
                </main>
                <aside
                  className="w-1/2 min-w-0 border-l border-slate-200 bg-slate-50 h-[calc(100vh-64px)] sticky top-16"
                  data-testid="desktop-map-pane"
                >
                  <PersistentMapShell />
                </aside>
              </div>
            </div>
          </div>
          <Footer />
          <BottomNav />
        </>
      )}
    </div>
  );
}


// 'use client';

// import { usePathname } from 'next/navigation';
// import { Sidebar } from '@/widgets/sidebar/ui/Sidebar';
// import { Header } from '@/widgets/header/ui/Header';
// import { BottomNav } from '@/widgets/bottom-nav/ui/BottomNav';

// export default function MainLayout({ children }: { children: React.ReactNode }) {
//   const pathname = usePathname();
//   const isLanding = pathname === '/';

//   return (
//     <div className="flex h-screen w-full">
//       {!isLanding && <Sidebar />}
//       <div className={`flex-1 flex flex-col min-w-0 ${!isLanding ? 'md:ml-20' : ''}`}>
//         <Header />
//         <main
//           className={
//             isLanding
//               ? 'flex-1 overflow-auto bg-white'
//               : 'flex-1 overflow-auto bg-brand-bg pb-16 md:pb-0'
//           }
//         >
//           {children}
//         </main>
//       </div>
//       <BottomNav />
//     </div>
//   );
// }
