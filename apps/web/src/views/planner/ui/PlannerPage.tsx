'use client';

import React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCollaborationSocket, CollaboratorsAvatarGroup } from '@/features/route-collaborate';
import { LoginModal, RegisterModal } from '@/features/auth';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui';
import { Button } from '@/shared/ui/button';
import { X } from 'lucide-react';
import { PlannerConflictModal } from '@/widgets/planner-conflict-modal';
import { PopularRoutes } from '@/widgets/popular-routes';
import { usePlanner } from '@/views/planner/model/use-planner';
import { ConstructorTab } from '@/views/planner/ui/ConstructorTab';

type PlannerView = 'route' | 'budget' | 'todo';

export function PlannerPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const planner = usePlanner();

  const currentView = (searchParams.get('view') as PlannerView) ?? 'budget';

  const {
    activeTab,
    setActiveTab,
    modal,
    setModal,
    showClearConfirm,
    setShowClearConfirm,
    showPlannerConflictModal,
    setShowPlannerConflictModal,
    conflictType,
    currentTrip,
    handleConfirmClear,
    handleConfirmPlannerReplace,
    finalizeApplyFlow,
  } = planner;

  useCollaborationSocket(currentTrip?.id || '');

  const renderContent = () => {
    if (currentView === 'budget') {
      return <div className="p-8 h-full bg-slate-50 text-slate-400">Бюджет загружается...</div>;
    }
    if (currentView === 'todo') {
      return <div className="p-8 h-full bg-slate-50 text-slate-400">Todo загружается...</div>;
    }
    // currentView === 'route' — показываем конструктор маршрута
    return (
      <div className="bg-white min-h-screen w-full max-w-full flex flex-col">
        <div className="w-full mx-auto px-4 md:px-8 py-6 md:py-8 flex-1 flex flex-col relative min-h-0">
          <div className="mb-8 bg-white md:p-0 rounded-none w-full max-w-7xl mx-auto shrink-0">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl md:text-4xl font-black text-brand-indigo tracking-tight text-left">
                Маршруты
              </h2>
              {currentTrip?.id && !currentTrip.id.startsWith('guest-') && (
                <CollaboratorsAvatarGroup tripId={currentTrip.id} />
              )}
            </div>
            <SegmentedControl
              options={[
                { label: 'Конструктор', value: 'my' },
                { label: 'Популярные', value: 'popular' },
              ]}
              value={activeTab}
              onChange={(val) => {
                setActiveTab(val as 'my' | 'popular');
                const params = new URLSearchParams(searchParams.toString());
                params.set('tab', val);
                router.push(`/planner?${params.toString()}`);
              }}
            />
          </div>

          <div className="flex-1">
            {activeTab === 'my' ? <ConstructorTab {...planner} /> : <PopularRoutes />}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-white min-h-screen w-full max-w-full flex flex-col">
      <div className="flex-1">{renderContent()}</div>

      <Dialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-md border-none shadow-2xl rounded-[2.5rem] p-10 overflow-hidden"
        >
          <button
            onClick={() => setShowClearConfirm(false)}
            className="absolute top-6 right-6 w-10 h-10 rounded-full bg-slate-50 flex items-center justify-center text-slate-400 hover:text-brand-indigo hover:bg-slate-100 transition-all active:scale-95 group z-10"
          >
            <X size={20} strokeWidth={2.5} />
          </button>
          <DialogHeader className="gap-8">
            <DialogTitle className="text-xl font-black text-brand-indigo uppercase tracking-widest leading-tight">
              Новый маршрут
            </DialogTitle>
            <DialogDescription className="text-slate-500 font-bold text-lg leading-snug">
              Сохранить текущий маршрут?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-3 mt-8">
            <Button
              variant="ghost"
              className="flex-1 font-bold text-slate-400 hover:text-slate-600 hover:bg-slate-50 h-12 rounded-xl"
              onClick={() => handleConfirmClear(false)}
            >
              ОЧИСТИТЬ
            </Button>
            <Button
              variant="brand-indigo"
              className="flex-1 font-black uppercase tracking-widest h-12 rounded-xl shadow-lg shadow-brand-indigo/20"
              onClick={() => handleConfirmClear(true)}
            >
              СОХРАНИТЬ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
      <PlannerConflictModal
        open={showPlannerConflictModal}
        onOpenChange={setShowPlannerConflictModal}
        conflictType={conflictType}
        currentRouteTitle={currentTrip?.title?.trim() || 'без названия'}
        onCancel={() => finalizeApplyFlow(true)}
        onReplaceWithoutSave={handleConfirmPlannerReplace}
        onSaveAndReplace={async () => {
          try {
            if (currentTrip && !currentTrip.id.startsWith('guest-')) {
              const { tripsApi } = await import('@/entities/trip');
              await tripsApi.update(currentTrip.id, {
                title: currentTrip.title,
                description: currentTrip.description ?? undefined,
                budget: currentTrip.budget ?? undefined,
              });
            }
          } catch (e) {
            console.error('Failed to save current trip before replace:', e);
            const { toast } = await import('sonner');
            toast.error('Не удалось сохранить текущий маршрут');
          }
          handleConfirmPlannerReplace();
        }}
        onGoToPlannerOnly={() => finalizeApplyFlow(true)}
      />
    </div>
  );
}
