'use client'

import { useState } from 'react'
import { Map, Sparkles, Users, Route } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { LoginModal } from '@/features/auth'
import { RegisterModal } from '@/features/auth'

type Modal = 'login' | 'register' | null

const FEATURES = [
  { icon: Route, title: 'Умные маршруты', desc: 'TSP-оптимизация обходит все точки по кратчайшему пути' },
  { icon: Sparkles, title: 'AI-помощник', desc: 'GPT-4o и YandexGPT подбирают места под ваши интересы' },
  { icon: Users, title: 'Совместное планирование', desc: 'Планируйте поездки вместе в реальном времени' },
]

export function LandingPage() {
  const [modal, setModal] = useState<Modal>(null)

  return (
    <>
      <div className="flex flex-col items-center justify-center min-h-full px-6 py-20 text-center">
        {/* Hero */}
        <div className="flex items-center justify-center mb-6">
          <div className="bg-brand-sky text-white p-3 rounded-[4px] shadow-md">
            <Map size={36} strokeWidth={1.5} />
          </div>
        </div>

        <h1 className="text-5xl font-black text-brand-indigo tracking-tight mb-4 max-w-2xl">
          Планируй путешествия с&nbsp;AI
        </h1>

        <p className="text-lg text-slate-500 max-w-xl mb-10">
          TripAI строит оптимальные маршруты, советует места и помогает организовать поездку — один
          за всех.
        </p>

        <div className="flex gap-3 mb-20">
          <Button size="lg" variant="brand" onClick={() => setModal('register')}>
            Начать бесплатно
          </Button>
          <Button size="lg" variant="outline" onClick={() => setModal('login')}>
            Войти
          </Button>
        </div>

        {/* Features */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl w-full">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div
              key={title}
              className="flex flex-col items-center gap-3 p-6 bg-white rounded-2xl border border-slate-100 shadow-sm"
            >
              <div className="p-2.5 bg-brand-sky/10 text-brand-sky rounded-xl">
                <Icon size={22} strokeWidth={1.5} />
              </div>
              <p className="font-semibold text-brand-indigo">{title}</p>
              <p className="text-sm text-slate-500 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </div>

      <LoginModal
        open={modal === 'login'}
        onClose={() => setModal(null)}
        onSwitchToRegister={() => setModal('register')}
      />
      <RegisterModal
        open={modal === 'register'}
        onClose={() => setModal(null)}
        onSwitchToLogin={() => setModal('login')}
      />
    </>
  )
}
