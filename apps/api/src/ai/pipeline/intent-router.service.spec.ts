import { IntentRouterService } from './intent-router.service';
import { LlmClientService } from './llm-client.service';

describe('IntentRouterService', () => {
  const createService = (llmContent: string | Error) => {
    const create = jest.fn();

    if (llmContent instanceof Error) {
      create.mockRejectedValue(llmContent);
    } else {
      create.mockResolvedValue({
        choices: [{ message: { content: llmContent } }],
      });
    }

    const llmClientService = {
      client: {
        chat: {
          completions: {
            create,
          },
        },
      },
    } as unknown as LlmClientService;

    const service = new IntentRouterService(llmClientService);

    return { service, create };
  };

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
      [{ poi_id: 'poi-123', title: 'Точка 123' }],
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
    const { service } = createService(
      JSON.stringify({
        action_type: 'REMOVE_POI',
        confidence: 0.65,
        target_poi_id: null,
      }),
    );

    const result = await service.route(
      'удали эту точку из маршрута',
      [],
      [{ poi_id: 'poi-9', title: 'Точка 9' }],
    );

    expect(result).toMatchObject({
      action_type: 'REMOVE_POI',
      confidence: 0.65,
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
      [{ poi_id: 'poi-7', title: 'Пушкинский музей' }],
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
      [{ poi_id: 'poi-from-user', title: 'Точка пользователя' }],
    );

    expect(result.target_poi_id).toBe('poi-from-user');
  });

  it('falls back to NEW_ROUTE full_rebuild on invalid LLM payload', async () => {
    const { service } = createService('{"action_type":"UNKNOWN"}');

    const result = await service.route('любой запрос', []);

    expect(result).toEqual({
      action_type: 'NEW_ROUTE',
      confidence: 0,
      target_poi_id: null,
      route_mode: 'full_rebuild',
    });
  });
});
