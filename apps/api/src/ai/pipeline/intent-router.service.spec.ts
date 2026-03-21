import { IntentRouterService, IntentRouterContext } from './intent-router.service';
import { LlmClientService } from './llm-client.service';

describe('IntentRouterService', () => {
  const createService = (llmContent: string | Error) => {
    const chat = jest.fn();

    if (llmContent instanceof Error) {
      chat.mockRejectedValue(llmContent);
    } else {
      chat.mockResolvedValue(llmContent);
    }

    const llmClientService = {
      chat,
    } as unknown as LlmClientService;

    const service = new IntentRouterService(llmClientService);

    return { service, chat };
  };

  const makeCtx = (
    pois: Array<{ poi_id: string; title?: string | null }> = [],
    city: string | null = null,
  ): IntentRouterContext => ({
    has_existing_route: pois.length > 0,
    current_poi_count: pois.length,
    current_city: city,
    current_pois: pois,
  });

  it('routes through LLM and keeps targeted_mutation for confident REMOVE_POI', async () => {
    const { service } = createService(
      JSON.stringify({
        action_type: 'REMOVE_POI',
        confidence: 0.91,
        target_poi_id: 'poi-123',
      }),
    );

    const result = await service.route(
      'Удали точку',
      [],
      makeCtx([{ poi_id: 'poi-123', title: 'Точка 123' }]),
    );

    expect(result).toEqual({
      action_type: 'REMOVE_POI',
      confidence: 0.91,
      target_poi_id: 'poi-123',
      route_mode: 'targeted_mutation',
      fallback_reason: undefined,
    });
  });

  it('forces full_rebuild and LOW_CONFIDENCE for low-confidence non-NEW_ROUTE decisions', async () => {
    // LOW_CONFIDENCE threshold is < 0.4 in the service
    const { service } = createService(
      JSON.stringify({
        action_type: 'REMOVE_POI',
        confidence: 0.35,
        target_poi_id: null,
      }),
    );

    const result = await service.route(
      'удали эту точку из маршрута',
      [],
      makeCtx([{ poi_id: 'poi-9', title: 'Точка 9' }]),
    );

    expect(result).toMatchObject({
      action_type: 'REMOVE_POI',
      confidence: 0.35,
      target_poi_id: null,
      route_mode: 'full_rebuild',
      fallback_reason: 'LOW_CONFIDENCE',
    });
  });

  it('falls back to title matching for REMOVE_POI when target_poi_id is missing', async () => {
    const { service } = createService(
      JSON.stringify({
        action_type: 'REMOVE_POI',
        confidence: 0.75,
        target_poi_id: null,
      }),
    );

    const result = await service.route(
      'Удали точку пушкинский музей',
      [],
      makeCtx([{ poi_id: 'poi-7', title: 'Пушкинский музей' }]),
    );

    expect(result.target_poi_id).toBe('poi-7');
    expect(result.route_mode).toBe('targeted_mutation');
  });

  it('prefers explicit poi_id from user message over llm target', async () => {
    const { service } = createService(
      JSON.stringify({
        action_type: 'REPLACE_POI',
        confidence: 0.88,
        target_poi_id: 'poi-from-llm',
      }),
    );

    const result = await service.route(
      'замени точку poi_id:poi-from-user',
      [],
      makeCtx([{ poi_id: 'poi-from-user', title: 'Точка пользователя' }]),
    );

    expect(result.target_poi_id).toBe('poi-from-user');
  });

  it('falls back to NEW_ROUTE full_rebuild on invalid LLM payload', async () => {
    const { service } = createService('{"action_type":"UNKNOWN"}');

    const result = await service.route('любой запрос', [], makeCtx());

    expect(result).toEqual({
      action_type: 'NEW_ROUTE',
      confidence: 0,
      target_poi_id: null,
      route_mode: 'full_rebuild',
    });
  });

  it('guardrail: normalizes ADD_POI when LLM returns NEW_ROUTE but route exists', async () => {
    const { service } = createService(
      JSON.stringify({
        action_type: 'NEW_ROUTE',
        confidence: 0.8,
        target_poi_id: null,
      }),
    );

    const result = await service.route(
      'добавь кафе',
      [],
      makeCtx([{ poi_id: 'poi-1', title: 'Красная площадь' }]),
    );

    expect(result.action_type).toBe('ADD_POI');
    expect(result.route_mode).toBe('targeted_mutation');
  });

  it('guardrail: normalizes REMOVE_POI when LLM returns NEW_ROUTE but route exists', async () => {
    const { service } = createService(
      JSON.stringify({
        action_type: 'NEW_ROUTE',
        confidence: 0.8,
        target_poi_id: null,
      }),
    );

    const result = await service.route(
      'удали музей',
      [],
      makeCtx([{ poi_id: 'poi-1', title: 'Музей' }]),
    );

    expect(result.action_type).toBe('REMOVE_POI');
  });

  it('guardrail: allows explicit NEW_ROUTE reset even when route exists', async () => {
    const { service } = createService(
      JSON.stringify({
        action_type: 'NEW_ROUTE',
        confidence: 0.95,
        target_poi_id: null,
      }),
    );

    const result = await service.route(
      'начни заново с нуля',
      [],
      makeCtx([{ poi_id: 'poi-1', title: 'Красная площадь' }]),
    );

    expect(result.action_type).toBe('NEW_ROUTE');
  });
});
