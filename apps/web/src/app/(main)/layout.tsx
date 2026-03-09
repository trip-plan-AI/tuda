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
    // 1. Добавили `flex flex-col`, чтобы Header, Контент и Footer аккуратно делили высоту экрана
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
                <main className="flex-1 bg-white min-w-0">
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
          <Header />
          <div className="flex flex-1 w-full pt-0">
            <div className="flex w-full">
              <Sidebar />
              <main className="flex-1 flex flex-col relative w-full min-w-0 bg-white">
                {children}
              </main>
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
