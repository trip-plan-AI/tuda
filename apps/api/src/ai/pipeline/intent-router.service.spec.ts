import { IntentRouterService } from './intent-router.service';

describe('IntentRouterService', () => {
  it('forces full_rebuild and LOW_CONFIDENCE for low-confidence non-NEW_ROUTE decisions', () => {
    const service = new IntentRouterService();

    const result = service.route('удали эту точку из маршрута', []);

    expect(result).toMatchObject({
      action_type: 'REMOVE_POI',
      confidence: 0.65,
      route_mode: 'full_rebuild',
      fallback_reason: 'LOW_CONFIDENCE',
    });
  });
});
