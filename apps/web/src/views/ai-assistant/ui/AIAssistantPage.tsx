'use client';

import { useMemo } from 'react';
import { useAiQueryStore } from '@/features/ai-query';
import { useTripStore } from '@/entities/trip';
import { AiChat } from '@/widgets/ai-chat';

export function AIAssistantPage() {
  const { messages, isLoading, sendQuery, applyPlanToCurrentTrip, lastAppliedPlanMessageId } =
    useAiQueryStore();
  const currentTrip = useTripStore((state) => state.currentTrip);

  const messagesWithGreeting = useMemo(() => {
    if (messages.length > 0) return messages;

    return [
      {
        id: 'welcome-message',
        role: 'assistant' as const,
        content:
          'Привет! Я AI-помощник по путешествиям. Напиши город, даты и бюджет — соберу маршрут.',
        timestamp: new Date().toISOString(),
      },
    ];
  }, [messages]);

  const handleSend = async (query: string) => {
    await sendQuery(query, currentTrip?.id);
  };

  return (
    <div className="min-h-full w-full">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6 md:py-10">
        <AiChat
          messages={messagesWithGreeting}
          isLoading={isLoading}
          onSend={handleSend}
          onApplyPlan={applyPlanToCurrentTrip}
          lastAppliedPlanMessageId={lastAppliedPlanMessageId}
        />
      </div>
    </div>
  );
}
