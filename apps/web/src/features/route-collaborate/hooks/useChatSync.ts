'use client';

import { useEffect, useCallback } from 'react';
import { getSocket } from '@/shared/socket/socket-client';
import { useAiQueryStore } from '@/features/ai-query';
import type { ChatMessage } from '@/shared/types/ai-chat';

interface RemoteChatPayload {
  trip_id: string;
  id: string;
  content: string;
  timestamp: string;
  user_id: string;
  user_name: string;
}

interface AgentResponsePayload {
  trip_id: string;
  id: string;
  content: string;
  timestamp: string;
  route_plan: unknown | null;
}

/**
 * TRI-120: Синхронизация сообщений чата через WebSocket.
 *
 * - sendChatMessage(text) — отправляет сообщение в комнату trip_{tripId}.
 * - Входящие сообщения других участников добавляются в активную AI-сессию
 *   через addLocalMessage без вызова AI.
 *
 * Логика /help: проверяется ТОЛЬКО в вызывающем компоненте (AIAssistantPage).
 * Этот хук занимается исключительно транспортным слоем сокета.
 */
export function useChatSync(tripId: string) {
  useEffect(() => {
    if (!tripId || tripId.startsWith('guest-')) return;

    const socket = getSocket();

    const handleMessage = (data: RemoteChatPayload) => {
      const incomingMessage: ChatMessage = {
        id: data.id,
        role: 'user',
        // Префикс с именем отправителя, чтобы отличить чужие сообщения
        content: `${data.user_name}: ${data.content}`,
        timestamp: data.timestamp,
      };
      useAiQueryStore.getState().addLocalMessage(incomingMessage);
    };

    const handleAgentResponse = (data: AgentResponsePayload) => {
      const agentMessage: ChatMessage = {
        id: data.id,
        role: 'assistant',
        content: data.content,
        timestamp: data.timestamp,
        routePlan: (data.route_plan as ChatMessage['routePlan']) ?? undefined,
      };
      useAiQueryStore.getState().addLocalMessage(agentMessage);
    };

    // Load persisted chat history when joining the trip room
    const handleChatHistory = (messages: RemoteChatPayload[]) => {
      console.log('✅ Получена история чата:', messages);
      if (!Array.isArray(messages) || messages.length === 0) {
        console.warn('⚠️  chat:history получил пустой или не массив:', messages);
        return;
      }

      // TRI-120: RACE CONDITION FIX - передаём весь массив одним вызовом
      const mappedHistory: ChatMessage[] = messages.map((data) => ({
        id: data.id,
        role: 'user',
        content: `${data.user_name}: ${data.content}`,
        timestamp: data.timestamp,
      }));

      console.log('📦 Добавляем историю в стейт:', mappedHistory.length, 'сообщений');
      useAiQueryStore.getState().addChatHistory(mappedHistory);
    };

    socket.on('chat:history', handleChatHistory);
    socket.on('message:receive', handleMessage);
    socket.on('agent:receive', handleAgentResponse);

    return () => {
      socket.off('chat:history', handleChatHistory);
      socket.off('message:receive', handleMessage);
      socket.off('agent:receive', handleAgentResponse);
    };
  }, [tripId]);

  const sendChatMessage = useCallback(
    (text: string, messageId?: string) => {
      if (!tripId || tripId.startsWith('guest-')) return;
      const socket = getSocket();
      socket.emit('message:send', {
        trip_id: tripId,
        id: messageId || crypto.randomUUID(),
        content: text,
        timestamp: new Date().toISOString(),
      });
    },
    [tripId],
  );

  return { sendChatMessage };
}
