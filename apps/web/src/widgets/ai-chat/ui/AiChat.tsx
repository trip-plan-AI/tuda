'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { MessageBubble } from './MessageBubble';
import type { ChatMessage } from '@/shared/types/ai-chat';

interface AiChatProps {
  messages: ChatMessage[];
  isLoading?: boolean;
  onSend: (query: string) => void | Promise<void>;
  onApplyPlan?: (messageId: string) => void;
  lastAppliedPlanMessageId?: string | null;
  quickActions?: string[];
}

const DEFAULT_QUICK_ACTIONS = [
  'Добавь ресторан',
  'Сократи маршрут',
  'Что посмотреть?',
  'Смени город',
];

function AiResponseSkeleton() {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[85%] rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
        <div className="mt-2 h-3 w-full animate-pulse rounded bg-slate-100" />
        <div className="mt-1 h-3 w-4/5 animate-pulse rounded bg-slate-100" />

        <div className="mt-4 flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="h-3 w-3/5 animate-pulse rounded bg-slate-200" />
              <div className="mt-2 h-3 w-full animate-pulse rounded bg-slate-100" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AiChat({
  messages,
  isLoading = false,
  onSend,
  onApplyPlan,
  lastAppliedPlanMessageId = null,
  quickActions = DEFAULT_QUICK_ACTIONS,
}: AiChatProps) {
  const [query, setQuery] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSubmit = () => {
    const trimmed = query.trim();
    if (!trimmed || isLoading) return;
    if (trimmed.length > 1000) {
      setValidationError('Максимальная длина запроса — 1000 символов.');
      return;
    }

    setValidationError(null);
    onSend(trimmed);
    setQuery('');
  };

  return (
    <div className="flex h-full min-h-[560px] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-slate-50">
      <div className="border-b border-slate-200 bg-white px-5 py-4">
        <h2 className="text-base font-bold text-brand-indigo">AI Ассистент</h2>
        <p className="mt-1 text-xs text-slate-500">
          Спросите про маршрут, бюджет и идеи для путешествия
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center">
            <p className="max-w-sm text-sm text-slate-500">
              Напишите первый запрос, чтобы сгенерировать план поездки.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onApplyPlan={onApplyPlan}
                wasApplied={lastAppliedPlanMessageId === message.id}
              />
            ))}

            {isLoading && <AiResponseSkeleton />}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-slate-200 bg-white px-4 py-4">
        <div className="mb-3 flex flex-wrap gap-2">
          {quickActions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => onSend(action)}
              disabled={isLoading}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-brand-sky hover:text-brand-sky disabled:cursor-not-allowed disabled:opacity-50"
            >
              {action}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value.slice(0, 1000));
              if (validationError) setValidationError(null);
            }}
            placeholder="Например: 2 дня в Казани с бюджетом 10000"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
              }
            }}
            disabled={isLoading}
          />
          <Button
            type="button"
            variant="brand-purple"
            size="icon"
            onClick={handleSubmit}
            disabled={isLoading}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
          <span>{query.length}/1000</span>
          {validationError && <span className="text-red-500">{validationError}</span>}
        </div>
      </div>
    </div>
  );
}
