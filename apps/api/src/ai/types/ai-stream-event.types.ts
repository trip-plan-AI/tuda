import type { PlannerVersion } from './pipeline.types';

export interface PlanStartedSseEvent {
  event: 'plan_started';
  data: {
    request_id: string;
    planner_version: PlannerVersion;
  };
}

export interface HeartbeatSseEvent {
  event: 'heartbeat';
  data: {
    request_id: string;
    timestamp: string;
  };
}

export interface PlanFailedSseEvent {
  event: 'plan_failed';
  data: {
    request_id: string;
    code: string;
    message: string;
  };
}

export type PlannerSseEvent =
  | {
      type: PlanStartedSseEvent['event'];
      data: PlanStartedSseEvent['data'];
    }
  | {
      type: HeartbeatSseEvent['event'];
      data: HeartbeatSseEvent['data'];
    }
  | {
      type: PlanFailedSseEvent['event'];
      data: PlanFailedSseEvent['data'];
    };
