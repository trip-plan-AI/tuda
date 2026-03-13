import { LogicalIdSelectorService } from './logical-id-selector.service';

describe('LogicalIdSelectorService', () => {
  const candidates = [
    { id: 'id-1', name: 'Музей 1', category: 'museum' as const },
    { id: 'id-2', name: 'Парк 1', category: 'park' as const },
    { id: 'id-3', name: 'Кафе 1', category: 'cafe' as const },
  ];

  const createService = (content: string | Error) => {
    const llmClientService = {
      client: {
        chat: {
          completions: {
            create:
              content instanceof Error
                ? jest.fn().mockRejectedValue(content)
                : jest.fn().mockResolvedValue({
                    choices: [{ message: { content } }],
                  }),
          },
        },
      },
    };

    return {
      service: new LogicalIdSelectorService(llmClientService as never),
      llmClientService,
    };
  };

  it('returns validated ids when model output is valid JSON array', async () => {
    const { service } = createService('["id-2","id-1"]');

    const result = await service.selectIds({
      candidates,
      required_capacity: 2,
      food_policy: {
        food_mode: 'default',
        food_interval_hours: 4,
      },
    });

    expect(result).toEqual({
      selected_ids: ['id-2', 'id-1'],
      target: 2,
      selected_count: 2,
    });
  });

  it('falls back to deterministic top-N on invalid JSON', async () => {
    const { service } = createService('not-a-json');

    const result = await service.selectIds({
      candidates,
      required_capacity: 2,
      food_policy: {
        food_mode: 'default',
        food_interval_hours: 4,
      },
    });

    expect(result).toEqual({
      selected_ids: ['id-1', 'id-2'],
      target: 2,
      selected_count: 2,
      fallback_reason: expect.stringContaining('LOGICAL_SELECTOR_INVALID:'),
    });
  });

  it('falls back when model returns unknown ids', async () => {
    const { service } = createService('["id-2","id-404"]');

    const result = await service.selectIds({
      candidates,
      required_capacity: 2,
      food_policy: {
        food_mode: 'default',
        food_interval_hours: 4,
      },
    });

    expect(result).toEqual({
      selected_ids: ['id-1', 'id-2'],
      target: 2,
      selected_count: 2,
      fallback_reason: 'LOGICAL_SELECTOR_INVALID:UNKNOWN_ID:id-404',
    });
  });

  it('falls back when model returns duplicate ids', async () => {
    const { service } = createService('["id-2","id-2"]');

    const result = await service.selectIds({
      candidates,
      required_capacity: 2,
      food_policy: {
        food_mode: 'default',
        food_interval_hours: 4,
      },
    });

    expect(result).toEqual({
      selected_ids: ['id-1', 'id-2'],
      target: 2,
      selected_count: 2,
      fallback_reason: 'LOGICAL_SELECTOR_INVALID:DUPLICATE_ID:id-2',
    });
  });
});
