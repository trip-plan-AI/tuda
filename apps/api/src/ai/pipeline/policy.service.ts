import { Injectable } from '@nestjs/common';
import type {
  ParsedIntent,
  PlannerVersion,
  PolicySnapshot,
  SessionMessage,
} from '../types/pipeline.types';

@Injectable()
export class PolicyService {
  calculatePolicySnapshot(
    parsedIntent: ParsedIntent,
    history: SessionMessage[] = [],
    plannerVersion: Extract<PlannerVersion, 'v2-shadow' | 'v2'>,
  ): PolicySnapshot {
    const requiredCapacity = this.calculateRequiredCapacity(parsedIntent.days);
    const foodMode = this.resolveFoodMode(parsedIntent, history);

    return {
      required_capacity: requiredCapacity,
      food_policy: {
        food_mode: foodMode,
        food_interval_hours: foodMode === 'gastrotour' ? 2.0 : 4.0,
      },
      user_persona_summary: this.buildUserPersonaSummary(
        parsedIntent,
        foodMode,
      ),
      policy_version: plannerVersion,
    };
  }

  private calculateRequiredCapacity(days: number): number {
    const baseCapacity = days * 5;
    return Math.ceil(baseCapacity * 1.2);
  }

  private resolveFoodMode(
    parsedIntent: ParsedIntent,
    history: SessionMessage[],
  ): 'none' | 'gastrotour' | 'default' {
    const haystack = [
      parsedIntent.preferences_text,
      ...history.map((message) => message.content),
    ]
      .join(' ')
      .toLowerCase();

    if (
      /без\s+ед|без\s+ресторан|без\s+кафе|не\s+нужн\w*\s+ед|не\s+хочу\s+ед/u.test(
        haystack,
      )
    ) {
      return 'none';
    }

    if (
      /гастро|гастротур|кухн|дегустац|фудтур|по\s+ресторанам|рестораны\s+и\s+кафе/u.test(
        haystack,
      )
    ) {
      return 'gastrotour';
    }

    return 'default';
  }

  private buildUserPersonaSummary(
    parsedIntent: ParsedIntent,
    foodMode: 'none' | 'gastrotour' | 'default',
  ): string {
    const budgetSummary =
      parsedIntent.budget_per_day !== null
        ? `бюджет ~${parsedIntent.budget_per_day}/день`
        : 'бюджет не указан';

    return [
      `${parsedIntent.party_type}, ${parsedIntent.days} дн.`,
      budgetSummary,
      `еда: ${foodMode}`,
      parsedIntent.preferences_text?.trim() || 'без явных предпочтений',
    ].join('; ');
  }
}
