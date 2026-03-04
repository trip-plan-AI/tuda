import { Button } from '@/shared/ui/button';
import { Trip } from '@repo/types';

export default function Home() {
  // Тестовая переменная для проверки типов из бэкенда!
  const demoTrip: Partial<Trip> = {
    title: 'Моё первое путешествие',
    budget: 50000,
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24 bg-background text-foreground">
      <div className="z-10 max-w-5xl w-full items-center justify-center font-mono text-sm flex flex-col gap-8 text-center">
        <h1 className="text-6xl font-bold tracking-tighter">✈️ {demoTrip.title}</h1>
        <p className="text-xl text-muted-foreground max-w-150">
          Твой идеальный помощник в планировании путешествий. Построено на Next.js, Tailwind v4 и
          shadcn/ui.
        </p>
        <div className="flex gap-4">
          <Button size="lg">Начать планирование</Button>
          <Button size="lg" variant="outline">
            Узнать больше
          </Button>
        </div>
      </div>
    </main>
  );
}
