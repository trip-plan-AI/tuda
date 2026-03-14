import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface CollaborationEvent {
  type: 'trip:refresh' | 'ai:update';
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
}
