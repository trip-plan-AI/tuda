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
  let title = 'Внимание';
  let description: React.ReactNode = '';

  if (conflictType === 'landing_new') {
    description = (
      <>
        В конструкторе уже открыт маршрут{' '}
        <span className="font-extrabold text-brand-indigo">«{currentRouteTitle}»</span>.
        <br />
        При создании нового маршрута текущий будет заменен. Выберите действие:
      </>
    );
  } else if (conflictType === 'different_route') {
    description = (
      <>
        Сейчас в Planner открыт маршрут{' '}
        <span className="font-extrabold text-brand-indigo">«{currentRouteTitle}»</span>.
        <br />
        Если продолжить, он будет заменён выбранным маршрутом. Выберите действие:
      </>
    );
  } else if (conflictType === 'same_route') {
    description = (
      <>
        В планировщике сейчас открыта старая версия этого же маршрута.
        <br />
        Если вы продолжите, все текущие точки на карте будут безвозвратно заменены на новую версию.
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl border-none shadow-2xl rounded-[2.5rem] p-10 overflow-hidden z-[100]">
        <DialogHeader className="gap-4">
          <DialogTitle className="text-xl font-black text-brand-indigo uppercase tracking-widest leading-tight">
            {title}
          </DialogTitle>
          <DialogDescription className="text-slate-500 font-bold text-lg leading-snug">
            {description}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="flex-col gap-3 mt-8 sm:flex-col">
          <Button
            type="button"
            variant="ghost"
            className="w-full font-bold text-slate-400 hover:text-slate-600 hover:bg-slate-50 h-12 rounded-xl"
            onClick={onCancel}
          >
            Отмена
          </Button>

          <Button
            type="button"
            variant="outline"
            className="w-full font-bold h-12 rounded-xl border-slate-200 text-slate-600 hover:bg-slate-50"
            onClick={onGoToPlannerOnly}
          >
            Перейти в планнер (посмотреть старый)
          </Button>

          <Button
            type="button"
            className="w-full font-bold h-12 rounded-xl bg-amber-500 text-white hover:bg-amber-600 shadow-lg shadow-amber-500/20"
            onClick={onSaveAndReplace}
          >
            Сохранить старый и заменить
          </Button>

          <Button
            type="button"
            variant="brand-indigo"
            className="w-full font-black uppercase tracking-widest h-12 rounded-xl shadow-lg shadow-brand-indigo/20 bg-rose-600 hover:bg-rose-700"
            onClick={onReplaceWithoutSave}
          >
            Заменить без сохранения
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
