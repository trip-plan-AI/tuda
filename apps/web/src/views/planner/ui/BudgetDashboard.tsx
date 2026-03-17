'use client';

import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { Bed, Car, Eye, Utensils, MoreHorizontal } from 'lucide-react';

const SUMMARY_CARDS = [
  { label: 'ВСЕГО', value: '$0,00', color: 'text-slate-900' },
  { label: 'ОПЛАЧЕНО', value: '$0,00', color: 'text-emerald-500' },
  { label: 'ОЖИДАЕТ', value: '$0,00', color: 'text-amber-500' },
];

const AI_TIPS = [
  'Забронируйте жильё заранее — сэкономите до 30%',
  'Транспортная карта выгоднее разовых билетов',
  'Ужин в 18:00 дешевле, чем в 20:00',
];

const CATEGORIES = [
  { label: 'Жильё', icon: Bed, bg: 'bg-emerald-50', color: 'text-emerald-500' },
  { label: 'Транспорт', icon: Car, bg: 'bg-rose-50', color: 'text-rose-500' },
  { label: 'Развлечения', icon: Eye, bg: 'bg-amber-50', color: 'text-amber-500' },
  { label: 'Еда и напитки', icon: Utensils, bg: 'bg-purple-50', color: 'text-purple-500' },
  { label: 'Другое', icon: MoreHorizontal, bg: 'bg-slate-100', color: 'text-slate-500' },
];

const DONUT_DATA = [{ value: 1 }];

export function BudgetDashboard() {
  return (
    <div className="flex h-full bg-slate-50 min-h-screen">
      {/* ─── Left / Center column ─── */}
      <div className="flex-1 p-8 overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Бюджет</h1>
            <p className="text-slate-500 text-sm mt-0.5">Париж, Франция</p>
          </div>
          <div className="flex items-center gap-1 bg-white rounded-full p-1 border border-slate-100 shadow-sm">
            {['Все', 'Ожидают', 'Оплачено'].map((label, i) => (
              <button
                key={label}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  i === 0 ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          {SUMMARY_CARDS.map(({ label, value, color }) => (
            <div
              key={label}
              className="bg-white rounded-2xl shadow-sm p-5 flex flex-col gap-1"
            >
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                {label}
              </span>
              <span className={`text-xl font-black ${color}`}>{value}</span>
            </div>
          ))}
        </div>

        {/* AI Recommendations */}
        <div className="bg-amber-50/50 border border-amber-100 rounded-2xl p-5 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-base">✨</span>
            <span className="text-sm font-bold text-amber-600">AI Рекомендации</span>
          </div>
          <ul className="flex flex-col gap-2">
            {AI_TIPS.map((tip) => (
              <li key={tip} className="flex items-start gap-2 text-sm text-slate-600">
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                {tip}
              </li>
            ))}
          </ul>
        </div>

        {/* Empty state */}
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center">
            <MoreHorizontal size={24} className="text-slate-300" />
          </div>
          <p className="text-slate-400 font-medium">Нет расходов</p>
          <p className="text-slate-300 text-sm">Добавьте первый расход через кнопку в меню</p>
        </div>
      </div>

      {/* ─── Right column (Analytics) ─── */}
      <div className="w-80 bg-white border-l border-slate-100 p-6 flex flex-col gap-6 overflow-y-auto shrink-0">
        {/* Total budget header */}
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">
          Общий бюджет
        </p>

        {/* Donut chart */}
        <div className="flex flex-col items-center">
          <div className="relative w-44 h-44">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={DONUT_DATA}
                  cx="50%"
                  cy="50%"
                  innerRadius={52}
                  outerRadius={72}
                  dataKey="value"
                  startAngle={90}
                  endAngle={-270}
                  strokeWidth={0}
                >
                  <Cell fill="#f1f5f9" />
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            {/* Center label */}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-lg font-black text-slate-900">$0,00</span>
              <span className="text-xs text-slate-400">всего</span>
            </div>
          </div>

          {/* Legend */}
          <div className="grid grid-cols-2 gap-4 w-full mt-4">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <span className="text-xs text-slate-400 uppercase font-bold tracking-wide">
                  Оплачено
                </span>
              </div>
              <span className="text-sm font-bold text-slate-900 pl-3.5">$0,00</span>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                <span className="text-xs text-slate-400 uppercase font-bold tracking-wide">
                  Ожидает
                </span>
              </div>
              <span className="text-sm font-bold text-slate-900 pl-3.5">$0,00</span>
            </div>
          </div>
        </div>

        <hr className="border-slate-100" />

        {/* By category */}
        <div>
          <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">
            По категориям
          </p>
          <div className="flex flex-col gap-3">
            {CATEGORIES.map(({ label, icon: Icon, bg, color }) => (
              <div key={label} className="flex items-center gap-3">
                <div className={`${bg} ${color} rounded-xl p-2 shrink-0`}>
                  <Icon size={16} />
                </div>
                <span className="flex-1 text-sm font-medium text-slate-700">{label}</span>
                <span className="text-sm font-bold text-slate-400">$0,00</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
