import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/ui/dialog';
import { Clock, Route, Wallet, ArrowRight } from 'lucide-react';

interface CompareSaveModalProps {
  isOpen: boolean;
  onClose: () => void;
  metrics: {
    originalKm: number;
    newKm: number;
    originalHours: number;
    newHours: number;
    originalRub: number;
    newRub: number;
  };
}

export function CompareSaveModal({ isOpen, onClose, metrics }: CompareSaveModalProps) {
  if (!metrics) return null;

  const { originalKm, newKm, originalHours, newHours, originalRub, newRub } = metrics;
  const savedKm = originalKm - newKm;
  const hasSavings = savedKm > 0.1;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-xl font-black text-brand-indigo uppercase tracking-widest text-center">
            Результат оптимизации
          </DialogTitle>
        </DialogHeader>

        <div className="py-6 flex flex-col items-center gap-6">
          {hasSavings ? (
            <>
              <div className="text-center space-y-2 mb-2">
                <p className="text-slate-500 font-medium">Ваш маршрут успешно перестроен!</p>
                <p className="text-2xl font-black text-emerald-500">
                  Вы сэкономите: {savedKm.toFixed(1)} км
                </p>
              </div>

              <div className="w-full bg-slate-50 rounded-2xl border border-slate-100 overflow-hidden">
                <div className="grid grid-cols-[1fr_2fr_2fr] gap-4 p-4 border-b border-slate-200/60 bg-slate-100/50">
                  <div className="font-bold text-slate-500 text-sm uppercase tracking-wider">Параметр</div>
                  <div className="font-bold text-slate-500 text-sm uppercase tracking-wider text-center">До оптимизации</div>
                  <div className="font-bold text-emerald-600 text-sm uppercase tracking-wider text-center">После</div>
                </div>

                <div className="grid grid-cols-[1fr_2fr_2fr] gap-4 p-4 items-center border-b border-slate-100">
                  <div className="flex items-center gap-2 text-slate-600 font-medium">
                    <Route className="w-5 h-5 text-slate-400" />
                    <span>Путь</span>
                  </div>
                  <div className="text-center font-bold text-slate-700 text-lg">
                    {originalKm.toFixed(1)} км
                  </div>
                  <div className="text-center font-black text-emerald-600 text-lg flex items-center justify-center gap-2">
                    <ArrowRight className="w-4 h-4 text-emerald-400" />
                    {newKm.toFixed(1)} км
                  </div>
                </div>

                <div className="grid grid-cols-[1fr_2fr_2fr] gap-4 p-4 items-center border-b border-slate-100">
                  <div className="flex items-center gap-2 text-slate-600 font-medium">
                    <Clock className="w-5 h-5 text-slate-400" />
                    <span>Время</span>
                  </div>
                  <div className="text-center font-bold text-slate-700 text-lg">
                    {Math.round(originalHours * 60)} мин
                  </div>
                  <div className="text-center font-black text-emerald-600 text-lg flex items-center justify-center gap-2">
                    <ArrowRight className="w-4 h-4 text-emerald-400" />
                    {Math.round(newHours * 60)} мин
                  </div>
                </div>

                {originalRub > 0 && (
                  <div className="grid grid-cols-[1fr_2fr_2fr] gap-4 p-4 items-center">
                    <div className="flex items-center gap-2 text-slate-600 font-medium">
                      <Wallet className="w-5 h-5 text-slate-400" />
                      <span>Стоимость</span>
                    </div>
                    <div className="text-center font-bold text-slate-700 text-lg">
                      {originalRub.toFixed(0)} ₽
                    </div>
                    <div className="text-center font-black text-emerald-600 text-lg flex items-center justify-center gap-2">
                      <ArrowRight className="w-4 h-4 text-emerald-400" />
                      {newRub.toFixed(0)} ₽
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="text-center space-y-4 py-8">
              <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Route className="w-8 h-8 text-slate-400" />
              </div>
              <p className="text-slate-600 font-black text-xl uppercase tracking-wider">Маршрут уже оптимален!</p>
              <p className="text-slate-500 max-w-[300px] mx-auto">
                Текущий порядок точек обеспечивает самый короткий и быстрый путь. Никаких изменений не требуется.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
