import { Sidebar } from '@/widgets/sidebar/ui/Sidebar'
import { Header } from '@/widgets/header/ui/Header'
import { BottomNav } from '@/widgets/bottom-nav/ui/BottomNav'

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 ml-20 flex flex-col">
        <Header />
        <main className="flex-1 overflow-auto bg-brand-bg pb-16 md:pb-0">
          {children}
        </main>
      </div>
      <BottomNav />
    </div>
  )
}
