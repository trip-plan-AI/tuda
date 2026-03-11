'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/shared/ui';
import { Button } from '@/shared/ui/button';

export type PlannerConflictType = 'different_route' | 'same_route' | 'landing_new';

interface PlannerConflictModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conflictType: PlannerConflictType;
  currentRouteTitle?: string;
  onCancel: () => void;
  onReplaceWithoutSave: () => void;
  onSaveAndReplace: () => void;
  onGoToPlannerOnly: () => void;
}

export function PlannerConflictModal({
  open,
  onOpenChange,
  conflictType,
  currentRouteTitle = 'без названия',
  onCancel,
  onReplaceWithoutSave,
  onSaveAndReplace,
  onGoToPlannerOnly,
}: PlannerConflictModalProps) {
  let title = 'У вас есть несохраненный маршрут';
  let description: React.ReactNode = '';

  if (conflictType === 'landing_new') {
    description = (
      <>
        В конструкторе открыт маршрут{' '}
        <span className="font-semibold text-brand-indigo">«{currentRouteTitle}»</span>. Он будет
        потерян при создании нового.
      </>
    );
  } else if (conflictType === 'different_route') {
    description = (
      <>
        Сейчас в конструкторе открыт маршрут{' '}
        <span className="font-semibold text-brand-indigo">«{currentRouteTitle}»</span>. Если
        продолжить, он будет заменён.
      </>
    );
  } else if (conflictType === 'same_route') {
    description = (
      <>
        В конструкторе открыта другая версия этого маршрута. Если продолжить, текущие точки на карте
        будут заменены.
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl border-none shadow-2xl rounded-3xl p-8 overflow-hidden z-[100] gap-8">
        <DialogHeader className="gap-2">
          <DialogTitle className="text-2xl font-semibold text-slate-900 leading-tight">
            {title}
          </DialogTitle>
          <DialogDescription className="text-slate-600 text-base leading-relaxed">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 w-full">
          <Button
            type="button"
            className="w-full font-medium h-12 rounded-xl bg-brand-indigo text-white hover:bg-brand-indigo/90 shadow-md transition-all active:scale-[0.98]"
            onClick={onSaveAndReplace}
          >
            Сохранить текущий и применить новый
          </Button>

          <Button
            type="button"
            variant="outline"
            className="w-full font-medium h-12 rounded-xl border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-all active:scale-[0.98]"
            onClick={onGoToPlannerOnly}
          >
            Перейти в планнер (посмотреть текущий)
          </Button>

          <div className="grid grid-cols-2 gap-3 mt-2">
            <Button
              type="button"
              variant="ghost"
              className="w-full font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-100 h-12 rounded-xl transition-all"
              onClick={onCancel}
            >
              Отмена
            </Button>

            <Button
              type="button"
              variant="ghost"
              className="w-full font-medium h-12 rounded-xl text-rose-500 hover:bg-rose-50 hover:text-rose-600 transition-all"
              onClick={onReplaceWithoutSave}
            >
              Заменить без сохранения
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
