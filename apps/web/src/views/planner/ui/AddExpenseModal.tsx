'use client';

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
} from '@/shared/ui';
import {
  X,
  Grid2x2,
  Calendar,
  MapPin,
  Tag,
  ChevronDown,
  ChevronRight,
  Minus,
  Plus,
} from 'lucide-react';
import { useBudgetStore } from '@/views/planner/model/use-budget-store';

export function AddExpenseModal() {
  const { isExpenseModalOpen, closeExpenseModal } = useBudgetStore();
  const [isPaid, setIsPaid] = useState(false);

  return (
    <Dialog open={isExpenseModalOpen} onOpenChange={(open) => !open && closeExpenseModal()}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-lg border-none shadow-2xl rounded-3xl p-0 overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <div className="w-8" />
          <h2 className="text-lg font-bold text-slate-800">Новый расход</h2>
          <button
            onClick={closeExpenseModal}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-400 hover:bg-slate-200 transition-colors"
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>

        <div className="px-6 pb-6 flex flex-col gap-0">
          {/* Filter row */}
          <div className="flex items-center gap-2 mb-6">
            {[
              { icon: Grid2x2, label: 'Другое' },
              { icon: Calendar, label: '17.03.2026' },
              { icon: MapPin, label: 'Место' },
            ].map(({ icon: Icon, label }) => (
              <button
                key={label}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-full text-sm text-slate-500 hover:border-slate-300 transition-colors"
              >
                <Icon size={14} className="text-slate-400" />
                {label}
              </button>
            ))}
          </div>

          {/* Amount input */}
          <div className="bg-slate-50 rounded-2xl p-4 flex items-center gap-4 mt-2">
            <div className="flex flex-col items-start shrink-0">
              <span className="text-xl font-black text-slate-900">$</span>
              <div className="flex items-center gap-0.5 mt-0.5">
                <span className="text-xs text-slate-400 font-medium">USD</span>
                <ChevronDown size={12} className="text-slate-400" />
              </div>
            </div>
            <input
              type="text"
              defaultValue="0.00"
              className="flex-1 text-4xl font-semibold text-slate-300 bg-transparent border-none outline-none min-w-0"
            />
          </div>

          {/* Title input */}
          <div className="flex items-center gap-3 border-b border-slate-100 px-1 py-4 mt-2">
            <Tag size={18} className="text-slate-400 shrink-0" />
            <input
              type="text"
              placeholder="Название расхода..."
              className="flex-1 text-sm text-slate-700 placeholder:text-slate-300 bg-transparent border-none outline-none"
            />
          </div>

          {/* Payment status */}
          <div className="flex items-center border-y border-slate-100 py-4 px-1 mt-0">
            <span className="flex-1 text-sm font-medium text-slate-700">Статус</span>
            <div className="flex items-center gap-3">
              <span className={`text-sm font-medium ${isPaid ? 'text-emerald-500' : 'text-slate-400'}`}>
                {isPaid ? 'Оплачено' : 'Не оплачено'}
              </span>
              {/* Toggle switch */}
              <button
                onClick={() => setIsPaid((v) => !v)}
                className={`relative w-10 h-6 rounded-full transition-colors ${
                  isPaid ? 'bg-emerald-400' : 'bg-slate-200'
                }`}
              >
                <span
                  className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all ${
                    isPaid ? 'left-5' : 'left-1'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Split section */}
          <div className="flex flex-col gap-3 mt-4">
            {/* Paid by row */}
            <button className="flex items-center gap-3 px-1 py-2 hover:bg-slate-50 rounded-xl transition-colors w-full text-left">
              <div className="w-8 h-8 rounded-full bg-brand-sky flex items-center justify-center text-white text-xs font-bold shrink-0">
                Я
              </div>
              <span className="flex-1 text-sm font-medium text-slate-700">Оплатил(а) Вы</span>
              <ChevronRight size={16} className="text-slate-300" />
            </button>

            {/* Everyone 1x row */}
            <div className="flex items-center gap-3 px-1 py-2">
              <div className="w-8 h-8 rounded-full bg-brand-sky flex items-center justify-center text-white text-xs font-bold shrink-0">
                Я
              </div>
              <span className="flex-1 text-sm font-medium text-slate-700">Everyone</span>
              <div className="flex items-center gap-2">
                <button className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center hover:bg-slate-200 transition-colors">
                  <Minus size={12} className="text-slate-500" />
                </button>
                <span className="text-sm font-bold text-slate-700 w-4 text-center">1x</span>
                <button className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center hover:bg-slate-200 transition-colors">
                  <Plus size={12} className="text-slate-500" />
                </button>
              </div>
              <input
                type="text"
                defaultValue="0,00"
                className="w-16 text-right text-sm font-bold text-slate-400 bg-transparent border-none outline-none"
              />
            </div>
          </div>

          {/* Save button */}
          <button className="bg-amber-400 hover:bg-amber-500 text-white rounded-xl py-4 w-full font-bold mt-6 transition-colors text-sm">
            Сохранить расход
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
