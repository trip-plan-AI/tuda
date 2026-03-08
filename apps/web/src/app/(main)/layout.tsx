'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/widgets/sidebar/ui/Sidebar';
import { Header } from '@/widgets/header/ui/Header';
import { BottomNav } from '@/widgets/bottom-nav/ui/BottomNav';
import { Footer } from '@/widgets/footer';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLanding = pathname === '/';
  
  const isProfile = pathname?.startsWith('/profile');

  return (
    // 1. Добавили `flex flex-col`, чтобы Header, Контент и Footer аккуратно делили высоту экрана
    <div className="bg-white min-h-screen flex flex-col" >
      {isLanding ? (
        <>
          <div className="relative">
            <div className="absolute top-0 left-0 right-0 z-50">
              <Header />
            </div>
            <main className="flex-1 overflow-auto bg-white">
              {children}
            </main>
          </div>
          <Footer />
          <BottomNav />
        </>
      ) : (
        <>
          <Header />
          {/* 2. `flex-1` заставляет этот блок занимать только свободное место между хедером и футером */}
          <div className="flex flex-1 justify-center w-full pt-0">
            {/* 3. УПРАВЛЕНИЕ ПРАВОЙ СТОРОНОЙ И ВЫСОТОЙ:
                - Классы `pr-4 lg:pr-12 xl:pr-24` — это твой рычаг управления правой границей!
                  Если хочешь отодвинуть карту сильнее от правого края, просто увеличь их (например, `xl:pr-40`).
                - `pb-8` (padding-bottom) — немного отступает снизу, чтобы футер "дышал" и не прилипал к карте.
            */}
            <div className={`flex w-full ${isProfile ? 'max-w-[1900px] ' : 'max-w-[1104px]'}`}  >
              <Sidebar />
              
              {/* 4. Убрали `min-h-screen` у main. Теперь он слушается родительский flex-1 и не выдавливает футер вниз */}
              <main className={`flex-1 flex flex-col relative w-full min-w-0 bg-white ${isProfile ? '' : 'max-w-5xl'}`}>
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
