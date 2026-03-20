import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export type AiThinkingStage =
  | 'collecting'    // Stage 1: fetching POIs from all sources (OSM, KudaGo, Photon)
  | 'hidden_gems'   // Stage 1.5: diving into local data, logical ID selection
  | 'selecting'     // Stage 2: semantic AI filter — choosing top N from raw pool
  | 'geocoding'     // Stage 2.5: validating and resolving coordinates
  | 'enrichment'    // Stage 3: LLM batch refinement (YandexGPT scoring)
  | 'scheduling'    // Stage 4: building day-by-day itinerary
  | 'chat';         // Conversational / free-form edit (TRAVEL_CHAT, no route-building steps)

export interface CollaborationEvent {
  type: 'trip:refresh' | 'ai:update' | 'ai:thinking' | 'ai:day_ready';
  tripId: string;
  userId?: string; // для персональной комнаты user_${userId} (события без tripId)
  payload?: any;
}

@Injectable()
export class CollaborationEventsService {
  private eventsSubject = new Subject<CollaborationEvent>();
  public events$ = this.eventsSubject.asObservable();

  emitTripRefresh(tripId: string) {
    this.eventsSubject.next({ type: 'trip:refresh', tripId });
  }

  emitAiUpdate(tripId: string, sessionId: string) {
    this.eventsSubject.next({
      type: 'ai:update',
      tripId,
      payload: { session_id: sessionId },
    });
  }

  emitAiThinking(tripId: string | null | undefined, sessionId: string, stage: AiThinkingStage, userId?: string) {
    this.eventsSubject.next({
      type: 'ai:thinking',
      tripId: tripId ?? '',
      userId,
      payload: { session_id: sessionId, stage },
    });
  }

  emitAiDayReady(tripId: string | null | undefined, sessionId: string, day: any, userId?: string) {
    this.eventsSubject.next({
      type: 'ai:day_ready',
      tripId: tripId ?? '',
      userId,
      payload: { session_id: sessionId, day },
    });
  }
}
