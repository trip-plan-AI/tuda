import { Injectable, Logger } from '@nestjs/common';
import type { UserMemoryProfile } from '../types/pipeline.types';

export type UserFeedbackSignal = 'CHOOSEN' | 'SKIPPED' | 'REJECTED';

export interface FeedbackEvent {
  poiId: string;
  category: string;
  tags?: string[];
  signal: UserFeedbackSignal;
  context?: {
    wasTired?: boolean;
    badWeather?: boolean;
    tooFar?: boolean;
    lackOfTime?: boolean;
  };
  timestamp: Date;
}

@Injectable()
export class UserMemoryService {
  private readonly logger = new Logger('AI_PIPELINE:UserMemoryService');

  /**
   * Applies time decay to a raw affinity score based on how long ago it was updated.
   * Prevents memory from "cementing" forever.
   */
  public getEffectiveAffinity(rawAffinity: number, lastUpdateDate: Date, currentDate: Date = new Date()): number {
    const msSinceUpdate = currentDate.getTime() - lastUpdateDate.getTime();
    const daysSinceUpdate = msSinceUpdate / (1000 * 60 * 60 * 24);
    
    if (daysSinceUpdate <= 0) return rawAffinity;

    // Decay factor: e^(-days / 30) - half-life of roughly 21 days
    const decayFactor = Math.exp(-daysSinceUpdate / 30);
    return rawAffinity * decayFactor;
  }

  /**
   * Updates user memory profile with new behavioral signals.
   * Handles signal differentiation and context-aware skips.
   */
  public processFeedback(profile: UserMemoryProfile, event: FeedbackEvent): UserMemoryProfile {
    let signalWeight = 0;

    switch (event.signal) {
      case 'CHOOSEN':
        signalWeight = 1.0;
        break;
      case 'REJECTED':
        signalWeight = -1.0;
        break;
      case 'SKIPPED':
        // If skipped due to external context, we don't penalize the preference
        if (event.context?.badWeather || event.context?.lackOfTime || event.context?.tooFar || event.context?.wasTired) {
          this.logger.debug(`Contextual skip for ${event.category}, signal neutralized.`);
          signalWeight = 0;
        } else {
          // Soft penalty for skipping without obvious reason
          signalWeight = -0.2;
        }
        break;
    }

    if (signalWeight === 0) {
      return profile; // No change needed
    }

    const updatedProfile = { ...profile };
    updatedProfile.categoryAffinity = { ...(profile.categoryAffinity || {}) };
    updatedProfile.tagsAffinity = { ...(profile.tagsAffinity || {}) };

    // 1. Update Category Affinity
    const currentCatAffinity = updatedProfile.categoryAffinity[event.category] || 0;
    updatedProfile.categoryAffinity[event.category] = this.calculateNewAffinity(currentCatAffinity, signalWeight);

    // 2. Update Tags Affinity
    if (event.tags && event.tags.length > 0) {
      for (const tag of event.tags) {
        const currentTagAffinity = updatedProfile.tagsAffinity[tag] || 0;
        updatedProfile.tagsAffinity[tag] = this.calculateNewAffinity(currentTagAffinity, signalWeight);
      }
    }

    return updatedProfile;
  }

  private calculateNewAffinity(oldValue: number, signalWeight: number): number {
    // new = old * 0.9 + signal * 0.1
    // Keeps value smoothly bounded between roughly -1.0 and 1.0
    const newValue = (oldValue * 0.9) + (signalWeight * 0.1);
    // Clamp between -1.0 and 1.0
    return Math.max(-1.0, Math.min(1.0, newValue));
  }
}
