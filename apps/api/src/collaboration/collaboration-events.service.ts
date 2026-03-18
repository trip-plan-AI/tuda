import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export type AiThinkingStage =
  | 'collecting'   // Stage 1: ProviderSearch
  | 'selecting'    // Stage 2: AI Selection
  | 'scheduling';  // Stage 3: Scheduler building days

export interface CollaborationEvent {
  type: 'trip:refresh' | 'ai:update' | 'ai:thinking' | 'ai:day_ready';
  tripId: string;
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

  emitAiThinking(tripId: string, sessionId: string, stage: AiThinkingStage) {
    this.eventsSubject.next({
      type: 'ai:thinking',
      tripId,
      payload: { session_id: sessionId, stage },
    });
  }

  emitAiDayReady(tripId: string, sessionId: string, day: any) {
    this.eventsSubject.next({
      type: 'ai:day_ready',
      tripId,
      payload: { session_id: sessionId, day },
    });
  }
}
