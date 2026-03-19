'use client';

import { useEffect, useCallback } from 'react';
import { getSocket } from '@/shared/socket/socket-client';
import { useAiQueryStore } from '@/features/ai-query';
import { useUserStore } from '@/entities/user';
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
// Хелпер: сообщение является собственным если user_id совпадает с текущим пользователем
function buildChatMessage(data: RemoteChatPayload, currentUserId: string | undefined): ChatMessage {
  const isOwn = !!currentUserId && data.user_id === currentUserId;
  return {
    id: data.id,
    role: 'user',
    content: data.content,
    timestamp: data.timestamp,
    // Своё сообщение — без userName/userAvatar, чтобы рендерилось справа
    ...(isOwn
      ? {}
      : {
          userName: data.user_name,
          userAvatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(data.user_name || 'U')}&background=random&color=fff`,
        }),
  };
}

export function useChatSync(tripId: string) {
  useEffect(() => {
    if (!tripId || tripId.startsWith('guest-')) return;

    const socket = getSocket();

    const handleMessage = (data: RemoteChatPayload) => {
      const currentUserId = useUserStore.getState().user?.id;
      useAiQueryStore.getState().addLocalMessageForTrip(
        data.trip_id,
        buildChatMessage(data, currentUserId),
      );
    };

    const handleAgentResponse = (data: AgentResponsePayload) => {
      const agentMessage: ChatMessage = {
        id: data.id,
        role: 'assistant',
        content: data.content,
        timestamp: data.timestamp,
        routePlan: (data.route_plan as ChatMessage['routePlan']) ?? undefined,
      };
      useAiQueryStore.getState().addLocalMessageForTrip(data.trip_id, agentMessage);
    };

    // Load persisted chat history when joining the trip room
    const handleChatHistory = (messages: RemoteChatPayload[]) => {
      if (!Array.isArray(messages) || messages.length === 0) return;

      const currentUserId = useUserStore.getState().user?.id;
      const mappedHistory: ChatMessage[] = messages.map((data) =>
        buildChatMessage(data, currentUserId),
      );

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
