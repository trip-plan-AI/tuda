'use client';

import React from 'react';
import {
  Search,
  MapPin,
  Route as RouteIcon,
  Plus,
  MessageSquare,
  ArrowRight,
  X,
  GripVertical,
  Calendar as CalendarIcon,
  AlertTriangle,
  Clock,
  Minus,
  ChevronDown,
} from 'lucide-react';
import { DndContext, closestCenter, DragOverlay } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { useTripStore } from '@/entities/trip';
import { formatDuration, formatDistance } from '@/shared/lib/route-utils';
import { PlannerPointRow } from '@/widgets/planner-point-row';
import { isSameDay } from '@/views/planner/lib/utils';
import type { PlannerState } from '@/views/planner/model/use-planner';

type ConstructorTabProps = PlannerState;

export function ConstructorTab(props: ConstructorTabProps) {
  const {
    searchInput,
    isSearching,
    showDropdown,
    setShowDropdown,
    suggestions,
    focusCoords,
    setFocusCoords,
    showBudgetWarning,
    setShowBudgetWarning,
    editingPointId,
    setEditingPointId,
    editingTitle,
    setEditingTitle,
    showClearConfirm,
    setShowClearConfirm,
    modal,
    setModal,
    isAddPointMode,
    isOptimizationExpanded,
    setIsOptimizationExpanded,
    isDailyBudgetsExpanded,
    setIsDailyBudgetsExpanded,
    visibleCount,
    routeInfo,
    isRouteLoading,
    affectedSegments,
    activeId,
    isOptimizing,
    selectedDays,
    searchContainerRef,
    pointRefs,
    pointsContainerRef,
    userLocationRef,
    points,
    currentTrip,
    _hasHydrated,
    isDirty,
    optimizationResults,
    previousPoints,
    lastOptimizedProfile,
    isAlreadyOptimal,
    isMixedRoute,
    mixedModes,
    routeProfile,
    totalBudget,
    dailyBudgets,
    plannedBudget,
    budgetOverrun,
    isBudgetExceeded,
    isAuthenticated,
    sensors,
    crud,
    toggleDayFilter,
    handleProfileChange,
    handlePointUpdate,
    handleDragStart,
    handleDragCancel,
    handleDragEnd,
    geocode,
    handleSearchChange,
    handleAddByQuery,
    handleConfirmClear,
    handleEditWithAi,
    handleSelectSuggestion,
    handleUpdatePlannedBudget,
    handleOptimize,
    handleSave,
    setPreviousPoints,
    setOptimizationResults,
    setLastOptimizedPoints,
    setLastOptimizedProfile,
  } = props;

  return (
    <div className="animate-in fade-in duration-500 w-full relative">
      <div className="mb-10 w-full max-w-7xl mx-auto">
        {isBudgetExceeded && showBudgetWarning && (
          <div className="fixed right-4 bottom-20 md:bottom-6 z-40 animate-in slide-in-from-right-4 duration-300">
            <div className="relative group flex items-start gap-2 rounded-2xl border border-red-200 bg-white/95 backdrop-blur px-3 py-2 shadow-lg max-w-[300px]">
              <button
                onClick={() => setShowBudgetWarning(false)}
                className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-100 text-red-600 flex items-center justify-center hover:bg-red-200 transition-colors shadow-sm"
              >
                <X size={14} strokeWidth={3} />
              </button>
              <div className="mt-0.5 rounded-full bg-red-100 text-red-600 p-1.5 shrink-0">
                <AlertTriangle size={14} />
              </div>
              <div className="min-w-0 pr-2">
                <p className="text-xs md:text-sm font-black text-red-700 leading-tight">
                  Лимит превышен на {budgetOverrun.toLocaleString('ru-RU')} ₽
                </p>
                <p className="text-[11px] md:text-xs font-semibold text-slate-500 leading-tight mt-0.5">
                  Итого по точкам выше планируемого бюджета
                </p>
              </div>
            </div>
          </div>
        )}

        <div ref={searchContainerRef} className="w-full relative z-30">
          <div className="w-full relative group">
            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-brand-blue transition-colors">
              {isSearching ? (
                <div className="w-5 h-5 border-2 border-brand-blue border-t-transparent rounded-full animate-spin" />
              ) : (
                <Search size={20} />
              )}
            </div>
            <input
              type="text"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              onFocus={() => {
                if (searchInput.length > 2) {
                  setShowDropdown(true);
                  if (suggestions.length === 0) geocode(searchInput);
                }
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleAddByQuery()}
              placeholder="Поиск места..."
              className="w-full pl-12 pr-4 py-4 md:py-5 bg-slate-50 rounded-xl md:rounded-2xl border-none focus:ring-2 focus:ring-brand-blue/20 outline-none text-slate-800 font-bold text-base md:text-lg transition-all placeholder:text-slate-400 shadow-sm"
            />
          </div>
          {showDropdown && searchInput.length > 2 && (
            <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-2xl border border-slate-100 shadow-2xl overflow-hidden z-40 animate-in fade-in slide-in-from-top-2">
              <div className="flex flex-col">
                {suggestions.length > 0 ? (
                  suggestions.map((s, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSelectSuggestion(s)}
                      className="flex items-center gap-3 w-full text-left px-5 py-4 hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0 group"
                    >
                      <div className="w-8 h-8 rounded-full bg-slate-100 group-hover:bg-brand-blue/10 flex items-center justify-center text-slate-400 group-hover:text-brand-blue transition-colors shrink-0">
                        <MapPin size={14} />
                      </div>
                      <span className="font-bold text-slate-700 group-hover:text-brand-indigo truncate flex-1">
                        {s.displayName}
                      </span>
                      <Plus
                        size={14}
                        className="ml-auto text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      />
                    </button>
                  ))
                ) : (
                  <div className="px-5 py-4 text-slate-500 text-sm font-medium text-center">
                    Ничего не найдено
                  </div>
                )}
                <button
                  onClick={() => {}}
                  className="flex items-center gap-3 w-full text-left px-5 py-5 bg-slate-50 hover:bg-slate-100 transition-colors group mt-2 border-t border-slate-100"
                >
                  <div className="w-12 h-12 rounded-2xl bg-brand-purple text-white flex items-center justify-center shadow-lg shadow-brand-purple/20 group-hover:scale-105 transition-transform duration-300">
                    <MessageSquare size={22} />
                  </div>
                  <div className="flex flex-col">
                    <span className="font-black text-brand-purple uppercase tracking-wider text-xs">
                      Найти с AI
                    </span>
                    <span className="text-slate-500 text-sm font-medium">
                      AI найдет место: «{searchInput}»
                    </span>
                  </div>
                  <ArrowRight
                    size={18}
                    className="ml-auto text-brand-purple transition-transform group-hover:translate-x-1"
                  />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4 mb-6 w-full max-w-7xl mx-auto">
        <div className="grid grid-cols-2 sm:flex sm:flex-row items-stretch bg-slate-100 p-1.5 rounded-[1.25rem] shadow-inner shrink-0 h-auto lg:h-16 gap-1 sm:gap-0">
          {_hasHydrated && isMixedRoute ? (
            <div className="col-span-2 sm:col-span-1 flex items-center justify-between px-4 sm:px-6 py-3.5 bg-white shadow-sm rounded-[1rem] flex-1 text-sm font-bold text-slate-700">
              <div className="flex items-center gap-2">
                <span className="hidden sm:inline">Смешанный маршрут</span>
                <span className="sm:hidden text-xs text-slate-400">Смешанный</span>
                <div className="flex gap-1.5 ml-1 md:ml-2">
                  {mixedModes.includes('driving') && (
                    <div
                      className="w-7 h-7 rounded-lg bg-[#eaf5fd] flex items-center justify-center shadow-xs"
                      title="Авто"
                    >
                      <span className="text-sm">🚗</span>
                    </div>
                  )}
                  {mixedModes.includes('foot') && (
                    <div
                      className="w-7 h-7 rounded-lg bg-brand-amber/10 flex items-center justify-center shadow-xs"
                      title="Пешком"
                    >
                      <span className="text-sm">🚶</span>
                    </div>
                  )}
                  {mixedModes.includes('bike') && (
                    <div
                      className="w-7 h-7 rounded-lg bg-emerald-50 flex items-center justify-center shadow-xs"
                      title="Вело"
                    >
                      <span className="text-sm">🚲</span>
                    </div>
                  )}
                  {mixedModes.includes('direct') && (
                    <div
                      className="w-7 h-7 rounded-lg bg-brand-purple/10 flex items-center justify-center shadow-xs"
                      title="Прямой"
                    >
                      <span className="text-sm">📏</span>
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleProfileChange((routeProfile as any) || 'driving')}
                className="ml-4 w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center hover:bg-red-100 hover:text-red-500 transition-colors"
                title="Сбросить на единый профиль"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={() => handleProfileChange('driving')}
                disabled={points.length < 2}
                className={cn(
                  'px-4 sm:px-6 py-3.5 rounded-[1rem] text-sm font-black transition-all flex items-center justify-center h-full disabled:opacity-40 disabled:cursor-default border border-transparent',
                  routeProfile === 'driving'
                    ? 'bg-white text-brand-blue shadow-sm border-slate-100'
                    : 'text-slate-500 hover:text-brand-blue hover:bg-white/50',
                )}
              >
                <span className="leading-none align-middle -translate-y-px mr-2 text-base">🚗</span>{' '}
                Авто
              </button>
              <button
                onClick={() => handleProfileChange('foot')}
                disabled={points.length < 2}
                className={cn(
                  'px-4 sm:px-6 py-3.5 rounded-[1rem] text-sm font-black transition-all flex items-center justify-center h-full disabled:opacity-40 disabled:cursor-default border border-transparent',
                  routeProfile === 'foot'
                    ? 'bg-white text-brand-amber shadow-sm border-slate-100'
                    : 'text-slate-500 hover:text-brand-amber hover:bg-white/50',
                )}
              >
                <span className="leading-none align-middle -translate-y-px mr-2 text-base">🚶</span>{' '}
                Пешком
              </button>
              <button
                onClick={() => handleProfileChange('bike')}
                disabled={points.length < 2}
                className={cn(
                  'px-4 sm:px-6 py-3.5 rounded-[1rem] text-sm font-black transition-all flex items-center justify-center h-full disabled:opacity-40 disabled:cursor-default border border-transparent',
                  routeProfile === 'bike'
                    ? 'bg-white text-emerald-500 shadow-sm border-slate-100'
                    : 'text-slate-500 hover:text-emerald-500 hover:bg-white/50',
                )}
              >
                <span className="leading-none align-middle -translate-y-px mr-2 text-base">🚲</span>{' '}
                Вело
              </button>
              <button
                onClick={() => handleProfileChange('direct')}
                disabled={points.length < 2}
                className={cn(
                  'px-4 sm:px-6 py-3.5 rounded-[1rem] text-sm font-black transition-all flex items-center justify-center h-full disabled:opacity-40 disabled:cursor-default border border-transparent',
                  routeProfile === 'direct'
                    ? 'bg-white text-brand-purple shadow-sm border-slate-100'
                    : 'text-slate-500 hover:text-brand-purple hover:bg-white/50',
                )}
              >
                <span className="leading-none align-middle -translate-y-px mr-2 text-base">📏</span>{' '}
                Прямой
              </button>
            </>
          )}
        </div>

        {(routeInfo || isRouteLoading) && (
          <div
            data-testid="planner-route-info"
            className="flex items-center justify-center gap-6 px-6 py-3 bg-brand-indigo/5 rounded-[1.25rem] border border-brand-indigo/10 animate-in fade-in zoom-in-95 relative overflow-hidden transition-all duration-300 w-full lg:w-96 lg:h-16"
          >
            {isRouteLoading && (
              <div className="absolute inset-0 bg-white/40 flex items-center justify-center z-10 animate-in fade-in duration-200">
                <div className="w-5 h-5 border-2 border-brand-indigo border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            <div className={cn('flex items-center gap-6', isRouteLoading && 'opacity-40')}>
              {routeInfo && routeProfile !== 'direct' && (
                <>
                  <div className="flex items-center gap-2">
                    <Clock size={18} className="text-brand-blue" />
                    <span className="text-sm font-black text-slate-700 leading-none">
                      {formatDuration(routeInfo.duration)}
                    </span>
                  </div>
                  <div className="w-px h-8 bg-brand-indigo/10" />
                </>
              )}
              {routeInfo && (
                <div className="flex items-center gap-2">
                  <RouteIcon size={18} className="text-emerald-500" />
                  <span className="text-sm font-black text-slate-700 leading-none">
                    {formatDistance(routeInfo.distance)}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="max-w-7xl mx-auto w-full pt-10 pb-6 sticky top-0 md:top-[60px] z-40 bg-white/95 backdrop-blur-md shadow-sm border-b border-slate-100/50 md:border-none md:shadow-none md:bg-white/90 px-4 -mx-4 md:px-0 md:mx-auto before:content-[''] before:absolute before:inset-x-0 before:-top-[2px] before:h-[3px] before:bg-white before:-z-10">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Button
            onClick={() => {
              if (!isAuthenticated) {
                setModal('register');
                return;
              }
              if (points.length > 0 && isDirty) {
                setShowClearConfirm(true);
              } else {
                handleConfirmClear(false);
              }
            }}
            disabled={points.length < 2}
            variant="brand-blue"
            className="w-full font-black text-[9px] sm:text-[10px] md:text-xs tracking-wider md:tracking-widest uppercase py-3.5 md:py-6 rounded-xl md:rounded-2xl h-auto shadow-lg shadow-brand-blue/10"
          >
            НОВЫЙ
          </Button>

          <Button
            onClick={handleEditWithAi}
            disabled={points.length === 0}
            variant="brand-purple"
            className="w-full font-black text-[9px] sm:text-[10px] md:text-xs tracking-wider md:tracking-widest uppercase py-3.5 md:py-6 rounded-xl md:rounded-2xl h-auto shadow-lg shadow-brand-purple/10"
          >
            РЕДАКТИРОВАТЬ С AI
          </Button>

          <Button
            onClick={handleOptimize}
            disabled={points.length < 3 || isOptimizing || isAlreadyOptimal}
            variant="brand-yellow"
            className="w-full font-black text-[9px] sm:text-[10px] md:text-xs tracking-wider md:tracking-widest uppercase py-3.5 md:py-6 rounded-xl md:rounded-2xl h-auto shadow-lg shadow-brand-yellow/10"
          >
            {isOptimizing ? 'ОПТИМИЗАЦИЯ...' : isAlreadyOptimal ? 'ОПТИМАЛЬНО' : 'ОПТИМИЗИРОВАТЬ'}
          </Button>

          <Button
            onClick={handleSave}
            disabled={points.length === 0}
            variant="brand-indigo"
            className="w-full font-black text-[9px] sm:text-[10px] md:text-xs tracking-wider md:tracking-widest uppercase py-3.5 md:py-6 rounded-xl md:rounded-2xl h-auto shadow-lg shadow-brand-indigo/10"
          >
            СОХРАНИТЬ
          </Button>
        </div>

        {optimizationResults.status !== 'idle' && (
          <div className="mt-8 p-0 bg-white rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/20 overflow-hidden animate-in fade-in slide-in-from-top-4 duration-500 relative group/opt">
            {optimizationResults.status === 'optimal' ||
            (optimizationResults.status === 'success' &&
              routeProfile !== lastOptimizedProfile) ? (
              <div className="flex flex-col">
                <div
                  className={cn(
                    'p-6 md:p-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 bg-slate-50/50 cursor-pointer transition-colors hover:bg-slate-100/50',
                    isOptimizationExpanded ? 'border-b border-slate-100' : '',
                  )}
                  onClick={() => setIsOptimizationExpanded(!isOptimizationExpanded)}
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-white rounded-2xl shadow-sm border border-slate-100 flex items-center justify-center shrink-0">
                      <MapPin size={22} className="text-emerald-500" />
                    </div>
                    <div>
                      <h4 className="text-brand-indigo font-black uppercase tracking-widest text-sm md:text-base mb-1">
                        Маршрут оптимален
                      </h4>
                      <p className="text-slate-400 text-xs md:text-sm font-bold uppercase tracking-wider">
                        {routeProfile !== lastOptimizedProfile
                          ? `Порядок точек идеален для режима «${routeProfile === 'driving' ? 'Авто' : routeProfile === 'foot' ? 'Пешком' : routeProfile === 'bike' ? 'Вело' : 'Прямой'}»`
                          : 'Текущий порядок точек — самый эффективный'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 mt-4 md:mt-0 ml-auto">
                    <button
                      className="w-8 h-8 rounded-full bg-slate-50 text-slate-400 flex items-center justify-center transition-transform hover:bg-slate-200"
                      style={{
                        transform: isOptimizationExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      }}
                    >
                      <ChevronDown size={20} />
                    </button>
                  </div>
                </div>

                {isOptimizationExpanded && (
                  <div className="p-6 md:p-8 bg-white flex justify-start md:justify-end animate-in slide-in-from-top-2 fade-in">
                    <div className="px-6 py-3 bg-emerald-50 rounded-xl border border-emerald-100/50">
                      <span className="text-emerald-600 font-black text-xs uppercase tracking-widest flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                        Улучшение не требуется
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col">
                <div
                  className={cn(
                    'p-6 md:p-8 bg-gradient-to-r from-brand-indigo/[0.02] to-transparent flex flex-col md:flex-row items-start md:items-center justify-between gap-6 cursor-pointer hover:from-brand-indigo/[0.05] transition-colors',
                    isOptimizationExpanded ? 'border-b border-slate-50' : '',
                  )}
                  onClick={() => setIsOptimizationExpanded(!isOptimizationExpanded)}
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-brand-indigo rounded-2xl shadow-lg shadow-brand-indigo/20 flex items-center justify-center shrink-0">
                      <MapPin size={22} className="text-white" />
                    </div>
                    <div>
                      <h4 className="text-brand-indigo font-black uppercase tracking-widest text-sm md:text-base mb-1">
                        Маршрут оптимизирован
                      </h4>
                      <p className="text-slate-400 text-xs md:text-sm font-bold uppercase tracking-wider">
                        Мы нашли путь короче и быстрее
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 w-full md:w-auto justify-end mt-4 md:mt-0">
                    {previousPoints && !isOptimizationExpanded && (
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          useTripStore.getState().setPoints(previousPoints);
                          if (currentTrip && !currentTrip.id.startsWith('guest-')) {
                            const orderedIds = previousPoints.map((p) => p.id);
                            crud.reorder(orderedIds).catch(console.error);
                          }
                          setPreviousPoints(null);
                          setOptimizationResults({ status: 'idle', metrics: null });
                          setLastOptimizedPoints(null);
                          setLastOptimizedProfile(null);
                        }}
                        variant="ghost"
                        shape="xl"
                        className="text-slate-400 hover:text-brand-indigo hover:bg-brand-indigo/5 font-black uppercase tracking-widest text-[10px] md:text-xs h-10 px-6 border border-slate-200 transition-all active:scale-95"
                      >
                        Вернуть
                      </Button>
                    )}
                    <button
                      className="w-8 h-8 rounded-full bg-slate-50 text-slate-400 flex items-center justify-center transition-transform hover:bg-slate-200"
                      style={{
                        transform: isOptimizationExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      }}
                    >
                      <ChevronDown size={20} />
                    </button>
                  </div>
                </div>

                {isOptimizationExpanded && (
                  <div className="flex flex-col bg-white animate-in slide-in-from-top-2 fade-in">
                    {previousPoints && (
                      <div className="px-6 md:px-8 pt-6 flex justify-end">
                        <Button
                          onClick={(e) => {
                            e.stopPropagation();
                            useTripStore.getState().setPoints(previousPoints);
                            if (currentTrip && !currentTrip.id.startsWith('guest-')) {
                              const orderedIds = previousPoints.map((p) => p.id);
                              crud.reorder(orderedIds).catch(console.error);
                            }
                            setPreviousPoints(null);
                            setOptimizationResults({ status: 'idle', metrics: null });
                            setLastOptimizedPoints(null);
                            setLastOptimizedProfile(null);
                          }}
                          variant="ghost"
                          shape="xl"
                          className="text-slate-400 hover:text-brand-indigo hover:bg-brand-indigo/5 font-black uppercase tracking-widest text-[10px] md:text-xs h-10 px-6 border border-slate-200 transition-all active:scale-95"
                        >
                          Вернуть как было
                        </Button>
                      </div>
                    )}

                    <div className="p-6 md:p-8">
                      {optimizationResults.metrics && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
                          <div className="group bg-slate-50/50 p-6 rounded-3xl border border-slate-100 hover:border-emerald-500/30 transition-all duration-300">
                            <div className="flex items-center gap-3 mb-6">
                              <div className="w-8 h-8 rounded-xl bg-white shadow-sm border border-slate-100 flex items-center justify-center group-hover:scale-110 transition-transform">
                                <Clock size={16} className="text-brand-blue" />
                              </div>
                              <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                                Время в пути
                              </span>
                            </div>
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">
                                  Было:
                                </span>
                                <span className="text-sm font-bold text-slate-400 line-through decoration-slate-300">
                                  {formatDuration(
                                    Math.round(optimizationResults.metrics.originalHours * 3600),
                                  )}
                                </span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-black text-brand-blue uppercase tracking-widest">
                                  Стало:
                                </span>
                                <span className="text-xl font-black text-slate-700 tabular-nums">
                                  {formatDuration(
                                    Math.round(optimizationResults.metrics.newHours * 3600),
                                  )}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="group bg-slate-50/50 p-6 rounded-3xl border border-slate-100 hover:border-emerald-500/30 transition-all duration-300">
                            <div className="flex items-center gap-3 mb-6">
                              <div className="w-8 h-8 rounded-xl bg-white shadow-sm border border-slate-100 flex items-center justify-center group-hover:scale-110 transition-transform">
                                <RouteIcon size={16} className="text-emerald-500" />
                              </div>
                              <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                                Расстояние
                              </span>
                            </div>
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">
                                  Было:
                                </span>
                                <span className="text-sm font-bold text-slate-400 line-through decoration-slate-300">
                                  {optimizationResults.metrics.originalKm.toFixed(1)} км
                                </span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">
                                  Стало:
                                </span>
                                <span className="text-xl font-black text-slate-700 tabular-nums">
                                  {optimizationResults.metrics.newKm.toFixed(1)}{' '}
                                  <span className="text-sm text-slate-400">км</span>
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="relative max-w-7xl mx-auto w-full">
        <div className="w-full">
          <div className="mb-10 mt-10 w-full bg-white rounded-[2rem] p-6 md:p-8 border border-slate-100 shadow-xl shadow-slate-200/20">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12 pb-8 border-b border-slate-50">
              <h3 className="text-xl md:text-2xl font-black text-brand-indigo uppercase tracking-widest">
                Бюджет маршрута
              </h3>
              <div className="flex items-center gap-3">
                <span className="font-black text-brand-indigo uppercase tracking-widest text-xs md:text-sm flex items-center gap-1.5">
                  <span className="text-base">💳</span> Планируемый:
                </span>
                <div className="flex items-center justify-between border border-slate-200 rounded-xl px-2 py-2 bg-white hover:border-slate-300 transition-colors w-full sm:w-48">
                  <button
                    onClick={() => handleUpdatePlannedBudget(plannedBudget - 1000)}
                    className="text-slate-400 hover:text-brand-indigo transition-colors p-1 flex items-center justify-center"
                    type="button"
                  >
                    <Minus size={16} />
                  </button>
                  <div className="flex items-center justify-center flex-1 min-w-0">
                    <input
                      type="number"
                      min="0"
                      step="1000"
                      value={plannedBudget}
                      onChange={(e) =>
                        handleUpdatePlannedBudget(Number(e.target.value) || 0)
                      }
                      className="w-16 md:w-20 bg-transparent text-center font-bold text-brand-indigo outline-none text-sm md:text-base [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      style={{ MozAppearance: 'textfield' }}
                    />
                    <span className="text-slate-400 font-bold text-sm">₽</span>
                  </div>
                  <button
                    onClick={() => handleUpdatePlannedBudget(plannedBudget + 1000)}
                    className="text-slate-400 hover:text-brand-indigo transition-colors p-1 flex items-center justify-center"
                    type="button"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            </div>

            <div ref={pointsContainerRef} className="flex flex-col gap-3">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
              >
                <SortableContext
                  items={points.map((p) => p.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {points.map((point, i) => {
                    const prevPoint = points[i - 1];
                    const showHeader =
                      !prevPoint || !isSameDay(prevPoint.visitDate, point.visitDate);
                    const isPointVisible = i < visibleCount;

                    return (
                      <div
                        key={point.id}
                        ref={(el) => {
                          pointRefs.current[point.id] = el;
                        }}
                        className="flex flex-col gap-3"
                      >
                        {showHeader && isPointVisible && (
                          <div
                            className={cn(
                              'flex items-center gap-3',
                              i === 0 ? 'mb-2' : 'mt-8 mb-2',
                            )}
                          >
                            {(() => {
                              const dayKey = point.visitDate
                                ? format(new Date(point.visitDate), 'yyyy-MM-dd')
                                : 'no-date';
                              const isSelected = selectedDays.includes(dayKey);
                              return (
                                <button
                                  onClick={() => toggleDayFilter(dayKey)}
                                  className={cn(
                                    'px-4 py-1.5 rounded-full flex items-center gap-2 transition-all border',
                                    isSelected
                                      ? 'bg-brand-indigo text-white border-brand-indigo shadow-md scale-105'
                                      : 'bg-brand-indigo/5 border-brand-indigo/10 text-brand-indigo hover:bg-brand-indigo/10',
                                  )}
                                >
                                  <CalendarIcon
                                    size={14}
                                    className={isSelected ? 'text-white' : 'text-brand-indigo'}
                                  />
                                  <span className="text-[11px] font-black uppercase tracking-wider">
                                    {point.visitDate
                                      ? format(new Date(point.visitDate), 'd MMMM, EEEE', {
                                          locale: ru,
                                        })
                                      : 'Без даты'}
                                  </span>
                                </button>
                              );
                            })()}
                            <div className="h-px flex-1 bg-linear-to-r from-slate-100 to-transparent" />
                          </div>
                        )}
                        {isPointVisible ? (
                          <PlannerPointRow
                            point={point}
                            index={i}
                            isLast={i === points.length - 1}
                            nextPoint={points[i + 1]}
                            nextPointId={points[i + 1]?.id}
                            nextTransportMode={points[i + 1]?.transportMode}
                            editingPointId={editingPointId}
                            editingTitle={editingTitle}
                            setEditingPointId={setEditingPointId}
                            setEditingTitle={setEditingTitle}
                            onUpdate={handlePointUpdate}
                            onRemove={crud.remove}
                            onFocusPoint={setFocusCoords}
                            leg={routeInfo?.legs ? routeInfo.legs[i] : undefined}
                            isRouteLoading={isRouteLoading && affectedSegments.has(i)}
                            userLocation={userLocationRef.current ?? undefined}
                            prevPointDate={prevPoint?.visitDate}
                            prevPointDuration={prevPoint?.duration}
                          />
                        ) : (
                          <div
                            className="h-24 bg-slate-50/50 rounded-2xl border border-dashed border-slate-100 animate-pulse flex items-center px-4"
                            style={{ opacity: 0.5 }}
                          >
                            <div className="w-6 h-6 rounded-full bg-slate-100 mr-4" />
                            <div className="h-4 w-32 bg-slate-100 rounded" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </SortableContext>
                <DragOverlay adjustScale={false}>
                  {activeId ? (
                    <div className="w-full pointer-events-none opacity-90 scale-102 shadow-2xl rounded-2xl">
                      {(() => {
                        const activePoint = points.find((p) => p.id === activeId);
                        const idx = points.findIndex((p) => p.id === activeId);
                        if (!activePoint) return null;
                        return (
                          <div className="flex flex-row items-center lg:items-start justify-start gap-3 md:gap-4 bg-white p-4 rounded-2xl border-2 border-brand-blue shadow-xl">
                            <div className="flex items-center lg:items-start gap-2 lg:pt-1">
                              <GripVertical size={16} className="text-brand-blue" />
                              <div className="w-7 h-7 shrink-0 rounded-full bg-brand-blue text-white font-bold hidden lg:flex items-center justify-center text-[12px] leading-none shadow-[0_2px_8px_rgba(0,0,0,0.3)] border-2 border-white">
                                {idx + 1}
                              </div>
                            </div>
                            <div className="flex-1 flex flex-col items-start gap-2 min-w-0 pr-10 w-full">
                              <div className="flex items-center gap-2 w-full">
                                <span className="font-bold text-slate-700 text-sm md:text-base truncate">
                                  {activePoint.title}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl w-full">
                                <MapPin size={14} className="text-slate-400 shrink-0" />
                                <span className="text-xs text-slate-500 font-bold truncate">
                                  {activePoint.address || 'Адрес не указан'}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
              {points.length === 0 && (
                <p className="text-center text-slate-400 text-sm py-4">
                  Пока нет добавленных мест
                </p>
              )}

              {(dailyBudgets.length > 0 || totalBudget > 0) && (
                <div className="mt-10 pt-10 border-t border-slate-50 flex flex-col gap-6">
                  {dailyBudgets.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {dailyBudgets.slice(0, 3).map(([dayKey, dailyTotal]) => {
                        const date = dayKey === 'no-date' ? null : new Date(dayKey);
                        const isSelected = selectedDays.includes(dayKey);
                        return (
                          <button
                            key={dayKey}
                            onClick={() => toggleDayFilter(dayKey)}
                            className={cn(
                              'flex items-center justify-between p-2 rounded-xl transition-all',
                              isSelected
                                ? 'bg-brand-indigo/10 border border-brand-indigo/20 shadow-sm'
                                : 'hover:bg-slate-50 border border-transparent',
                            )}
                          >
                            <span
                              className={cn(
                                'text-[10px] md:text-xs font-bold uppercase tracking-wider shrink-0',
                                isSelected ? 'text-brand-indigo' : 'text-slate-400',
                              )}
                            >
                              {date ? format(date, 'd MMMM', { locale: ru }) : 'Без даты'}
                            </span>
                            <div
                              className={cn(
                                'mx-4 flex-1 h-px border-t border-dashed',
                                isSelected ? 'border-brand-indigo/30' : 'border-slate-200',
                              )}
                            />
                            <span
                              className={cn(
                                'text-xs md:text-sm font-black tabular-nums shrink-0',
                                isSelected ? 'text-brand-indigo' : 'text-slate-600',
                              )}
                            >
                              {dailyTotal.toLocaleString('ru-RU')} ₽
                            </span>
                          </button>
                        );
                      })}

                      {dailyBudgets.length > 3 && (
                        <div className="flex flex-col gap-2">
                          {isDailyBudgetsExpanded && (
                            <div className="flex flex-col gap-2 animate-in slide-in-from-top-2 fade-in duration-300">
                              {dailyBudgets.slice(3).map(([dayKey, dailyTotal]) => {
                                const date = dayKey === 'no-date' ? null : new Date(dayKey);
                                const isSelected = selectedDays.includes(dayKey);
                                return (
                                  <button
                                    key={dayKey}
                                    onClick={() => toggleDayFilter(dayKey)}
                                    className={cn(
                                      'flex items-center justify-between p-2 rounded-xl transition-all',
                                      isSelected
                                        ? 'bg-brand-indigo/10 border border-brand-indigo/20 shadow-sm'
                                        : 'hover:bg-slate-50 border border-transparent',
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        'text-[10px] md:text-xs font-bold uppercase tracking-wider shrink-0',
                                        isSelected ? 'text-brand-indigo' : 'text-slate-400',
                                      )}
                                    >
                                      {date
                                        ? format(date, 'd MMMM', { locale: ru })
                                        : 'Без даты'}
                                    </span>
                                    <div
                                      className={cn(
                                        'mx-4 flex-1 h-px border-t border-dashed',
                                        isSelected
                                          ? 'border-brand-indigo/30'
                                          : 'border-slate-200',
                                      )}
                                    />
                                    <span
                                      className={cn(
                                        'text-xs md:text-sm font-black tabular-nums shrink-0',
                                        isSelected ? 'text-brand-indigo' : 'text-slate-600',
                                      )}
                                    >
                                      {dailyTotal.toLocaleString('ru-RU')} ₽
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          <button
                            onClick={() => setIsDailyBudgetsExpanded(!isDailyBudgetsExpanded)}
                            className="w-full mt-1 px-4 py-2 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-400 hover:text-brand-indigo transition-all flex items-center justify-center gap-2 group"
                          >
                            <span className="text-[10px] font-black uppercase tracking-widest">
                              {isDailyBudgetsExpanded
                                ? 'Скрыть'
                                : `Еще ${dailyBudgets.length - 3} ${dailyBudgets.length - 3 === 1 ? 'день' : dailyBudgets.length - 3 < 5 ? 'дня' : 'дней'}`}
                            </span>
                            <ChevronDown
                              size={14}
                              className={cn(
                                'transition-transform duration-300',
                                isDailyBudgetsExpanded ? 'rotate-180' : 'rotate-0',
                              )}
                            />
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-2 px-2">
                    <h4 className="text-xs md:text-sm font-black text-slate-400 uppercase tracking-widest shrink-0">
                      ИТОГО ПО ТОЧКАМ
                    </h4>
                    <div className="flex flex-col items-end shrink-0">
                      <div
                        className={cn(
                          'text-2xl md:text-3xl font-black tabular-nums transition-colors',
                          plannedBudget > 0 && totalBudget > plannedBudget
                            ? 'text-red-500'
                            : 'text-brand-indigo',
                        )}
                      >
                        {totalBudget.toLocaleString('ru-RU')} ₽
                      </div>
                      {isBudgetExceeded && (
                        <p className="text-[10px] font-bold text-red-400 uppercase mt-1">
                          Превышение на {(totalBudget - plannedBudget).toLocaleString()} ₽
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
