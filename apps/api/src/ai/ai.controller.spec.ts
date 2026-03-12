import { AiController } from './ai.controller';
import { NotFoundException } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import type { AiPlanRequestDto } from './dto/ai-plan-request.dto';
import type {
  DeterministicPlannerDecisionSummary,
  MassCollectionShadowMeta,
  ParsedIntent,
  PolicySnapshot,
  RoutePlan,
} from './types/pipeline.types';
import { LogicalIdFilterService } from './pipeline/logical-id-filter.service';
import { DeterministicPlannerService } from './pipeline/deterministic-planner.service';
import type { PoiItem } from './types/poi.types';

describe('AiController plan contract fields', () => {
  const user = { id: 'user-1' };
  const dto: AiPlanRequestDto = {
    user_query: 'Построй маршрут по центру Москвы',
  };

  const parsedIntent: ParsedIntent = {
    city: 'Москва',
    days: 2,
    budget_total: 10000,
    budget_per_day: 5000,
    party_type: 'solo',
    party_size: 1,
    categories: ['museum'],
    excluded_categories: [],
    radius_km: 5,
    start_time: '10:00',
    end_time: '20:00',
    preferences_text: 'исторические места',
  };

  const routePlan: RoutePlan = {
    city: 'Москва',
    total_budget_estimated: 10000,
    days: [],
  };

  const poiItems: PoiItem[] = [
    {
      id: 'kudago-10',
      name: 'ГМИИ им. Пушкина',
      address: 'ул. Волхонка, 12, Москва',
      category: 'museum',
      coordinates: {
        lat: 55.747,
        lon: 37.605,
      },
    },
    {
      id: 'kudago-10',
      name: 'ГМИИ им. Пушкина',
      address: 'ул. Волхонка, 12, Москва',
      category: 'museum',
      coordinates: {
        lat: 55.7471,
        lon: 37.6051,
      },
    },
  ];

  const policySnapshot: PolicySnapshot = {
    required_capacity: 12,
    food_policy: {
      food_mode: 'default',
      food_interval_hours: 4,
    },
    user_persona_summary:
      'solo, 2 дн.; бюджет ~5000/день; еда: default; исторические места',
    policy_version: 'v2-shadow',
  };

  const massCollectionShadow: MassCollectionShadowMeta = {
    provider_stats: [
      {
        provider: 'kudago',
        attempted: true,
        raw_count: 2,
        used_count: 2,
        failed: false,
      },
      {
        provider: 'overpass',
        attempted: true,
        raw_count: 1,
        used_count: 1,
        failed: false,
      },
      {
        provider: 'llm_fill',
        attempted: false,
        raw_count: 0,
        used_count: 0,
        failed: false,
      },
    ],
    totals: {
      before_dedup: 3,
      after_dedup: 2,
      returned: 2,
    },
  };

  const createController = (options?: {
    withFallbacks?: boolean;
    yandexBatchRefinementError?: Error;
  }) => {
    const withFallbacks = options?.withFallbacks ?? false;
    const yandexBatchRefinementError = options?.yandexBatchRefinementError;

    const selectedPois: PoiItem[] = poiItems.map((poi, index) => ({
      ...poi,
      description: `Описание ${index + 1}`,
    }));

    const aiSessionsService = {
      getOrCreateForPlan: jest.fn().mockResolvedValue({
        id: 'session-1',
        messages: [],
      }),
      saveMessages: jest.fn().mockResolvedValue(undefined),
    };

    const orchestratorService = {
      parseIntent: jest.fn().mockResolvedValue(parsedIntent),
    };

    const providerSearchService = {
      fetchAndFilter: jest
        .fn()
        .mockImplementation((_intent: ParsedIntent, fallbacks: string[]) => {
          if (withFallbacks) {
            fallbacks.push('provider_fallback');
          }
          return {
            pois: poiItems,
            shadowDiagnostics: massCollectionShadow,
          };
        }),
    };

    const semanticFilterService = {
      select: jest.fn().mockResolvedValue(selectedPois),
    };

    const yandexBatchRefinementService = {
      refineSelectedInBatches: yandexBatchRefinementError
        ? jest.fn().mockRejectedValue(yandexBatchRefinementError)
        : jest.fn().mockResolvedValue({
            refined: selectedPois,
            diagnostics: {
              batch_count: 1,
              failed_batches: 0,
              fallback_reasons: [],
            },
          }),
    };

    const schedulerService = {
      buildPlan: jest.fn().mockReturnValue(routePlan),
    };

    const intentRouterService = {
      route: jest.fn().mockReturnValue({
        action_type: 'ADD_DAYS',
        confidence: 0.75,
        target_poi_id: null,
        route_mode: 'targeted_mutation',
      }),
    };

    const policyService = {
      calculatePolicySnapshot: jest.fn().mockReturnValue(policySnapshot),
    };

    const logicalIdFilterService = new LogicalIdFilterService();
    const vectorPrefilterService = {
      runShadowPrefilter: jest.fn().mockResolvedValue({
        status: 'ok',
        total_candidates: 2,
        selected_count: 2,
        top_k: 200,
      }),
    };
    const deterministicPlannerService = {
      buildInputHash: jest.fn().mockReturnValue('hash-abc-123'),
      buildDecisionLogSummary: jest.fn().mockReturnValue({
        days_count: 0,
        points_total: 0,
        unique_poi_count: 0,
        duplicate_poi_count: 0,
      } satisfies DeterministicPlannerDecisionSummary),
    } as unknown as DeterministicPlannerService;

    const controller = new AiController(
      aiSessionsService as never,
      {} as never,
      {} as never,
      orchestratorService as never,
      providerSearchService as never,
      semanticFilterService as never,
      schedulerService as never,
      intentRouterService as never,
      policyService as never,
      logicalIdFilterService,
      vectorPrefilterService as never,
      deterministicPlannerService,
      yandexBatchRefinementService as never,
    );

    return {
      controller,
      schedulerService,
      yandexBatchRefinementService,
      selectedPois,
    };
  };

  afterEach(() => {
    delete process.env.FF_PLANNER_V2_CONTRACT_FIELDS;
    delete process.env.FF_PLANNER_V2_ENABLED;
    delete process.env.FF_PLANNER_SSE_ENABLED;
    delete process.env.FF_INTENT_ROUTER_V2;
    delete process.env.FF_POLICY_CALC_V2;
    delete process.env.FF_LOGICAL_ID_FILTER_V2;
    delete process.env.FF_VECTOR_PREFILTER_REDIS;
    delete process.env.FF_DETERMINISTIC_PLANNER_V2;
    delete process.env.FF_MASS_COLLECTION_V2;
    delete process.env.FF_YANDEX_BATCH_REFINEMENT;
    delete process.env.AI_VECTOR_TOPK;
    jest.clearAllMocks();
  });

  it('plan stream is unavailable when FF_PLANNER_SSE_ENABLED is false', () => {
    process.env.FF_PLANNER_SSE_ENABLED = 'false';
    const { controller } = createController();

    const reqMock = {
      on: jest.fn(),
      off: jest.fn(),
    } as never;

    expect(() => controller.planStream(reqMock)).toThrow(NotFoundException);
  });

  it('plan stream emits plan_started as first event when FF_PLANNER_SSE_ENABLED is true', async () => {
    process.env.FF_PLANNER_SSE_ENABLED = 'true';
    process.env.FF_PLANNER_V2_ENABLED = 'false';
    const { controller } = createController();

    const handlers = new Map<string, () => void>();
    const reqMock = {
      on: jest
        .fn()
        .mockImplementation((eventName: string, handler: () => void) => {
          handlers.set(eventName, handler);
          return reqMock;
        }),
      off: jest.fn().mockImplementation((eventName: string) => {
        handlers.delete(eventName);
        return reqMock;
      }),
    } as never;

    const stream$ = controller.planStream(reqMock);
    const firstEvent = await firstValueFrom(stream$);

    expect(firstEvent).toMatchObject({
      type: 'plan_started',
      data: {
        planner_version: 'v2-shadow',
      },
    });
    expect((firstEvent.data as { request_id?: string }).request_id).toEqual(
      expect.any(String),
    );

    handlers.get('close')?.();
  });

  it('returns legacy response without new contract fields by default', async () => {
    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).not.toHaveProperty('planner_version');
    expect(result.meta).not.toHaveProperty('pipeline_status');
    expect(result.meta).toHaveProperty('parsed_intent');
    expect(result.meta).toHaveProperty('steps_duration_ms');
    expect(result.meta).toHaveProperty('poi_counts');
    expect(result.meta).toHaveProperty('fallbacks_triggered');
  });

  it('returns intent_router meta when both FF_INTENT_ROUTER_V2 and FF_PLANNER_V2_CONTRACT_FIELDS are true', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'true';
    process.env.FF_PLANNER_V2_ENABLED = 'false';
    process.env.FF_INTENT_ROUTER_V2 = 'true';

    const { controller } = createController({ withFallbacks: true });

    const result = await controller.plan(dto, user);

    expect(result.meta).toMatchObject({
      planner_version: 'v2-shadow',
      pipeline_status: {
        intent: 'ok',
        provider: 'fallback',
        semantic: 'fallback',
        scheduler: 'ok',
      },
      intent_router: {
        action_type: 'ADD_DAYS',
        confidence: 0.75,
        target_poi_id: null,
        route_mode: 'targeted_mutation',
      },
    });
  });

  it('does not include intent_router when FF_INTENT_ROUTER_V2=false and contract fields are enabled', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'true';
    process.env.FF_PLANNER_V2_ENABLED = 'false';
    process.env.FF_INTENT_ROUTER_V2 = 'false';

    const { controller } = createController({ withFallbacks: true });

    const result = await controller.plan(dto, user);

    expect(result.meta).toHaveProperty('planner_version');
    expect(result.meta).toHaveProperty('pipeline_status');
    expect(result.meta).not.toHaveProperty('intent_router');
  });

  it('includes policy_snapshot in meta when FF_POLICY_CALC_V2=true and contract fields are enabled', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'true';
    process.env.FF_POLICY_CALC_V2 = 'true';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).toHaveProperty('policy_snapshot');
    expect(result.meta).toMatchObject({
      policy_snapshot: {
        required_capacity: 12,
        food_policy: {
          food_mode: 'default',
          food_interval_hours: 4,
        },
        policy_version: 'v2-shadow',
      },
    });
  });

  it('does not include policy_snapshot when FF_POLICY_CALC_V2=false', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'true';
    process.env.FF_POLICY_CALC_V2 = 'false';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).not.toHaveProperty('policy_snapshot');
  });

  it('includes logical_id_shadow only when both FF_PLANNER_V2_CONTRACT_FIELDS and FF_LOGICAL_ID_FILTER_V2 are true', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'true';
    process.env.FF_LOGICAL_ID_FILTER_V2 = 'true';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).toHaveProperty('logical_id_shadow');
    expect(result.meta).toMatchObject({
      logical_id_shadow: {
        total_candidates: 2,
        duplicates_groups: 1,
        duplicates_total: 2,
      },
    });
  });

  it('does not include logical_id_shadow when logical-id flag is true but contract fields are disabled', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'false';
    process.env.FF_LOGICAL_ID_FILTER_V2 = 'true';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).not.toHaveProperty('logical_id_shadow');
  });

  it('includes vector_prefilter_shadow only when both FF_PLANNER_V2_CONTRACT_FIELDS and FF_VECTOR_PREFILTER_REDIS are true', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'true';
    process.env.FF_VECTOR_PREFILTER_REDIS = 'true';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).toHaveProperty('vector_prefilter_shadow');
    expect(result.meta).toMatchObject({
      vector_prefilter_shadow: {
        status: 'ok',
        total_candidates: 2,
        selected_count: 2,
        top_k: 200,
      },
    });
  });

  it('does not include vector_prefilter_shadow when vector flag is true but contract fields are disabled', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'false';
    process.env.FF_VECTOR_PREFILTER_REDIS = 'true';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).not.toHaveProperty('vector_prefilter_shadow');
  });

  it('includes deterministic_planner_shadow only when both FF_DETERMINISTIC_PLANNER_V2 and FF_PLANNER_V2_CONTRACT_FIELDS are true', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'true';
    process.env.FF_DETERMINISTIC_PLANNER_V2 = 'true';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).toHaveProperty('deterministic_planner_shadow');
    expect(result.meta).toMatchObject({
      deterministic_planner_shadow: {
        status: 'ok',
        input_hash: 'hash-abc-123',
        decision_summary: {
          days_count: 0,
          points_total: 0,
          unique_poi_count: 0,
          duplicate_poi_count: 0,
        },
        deterministic_mode: 'shadow',
      },
    });
  });

  it('does not include deterministic_planner_shadow when deterministic flag is true but contract fields are disabled', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'false';
    process.env.FF_DETERMINISTIC_PLANNER_V2 = 'true';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).not.toHaveProperty('deterministic_planner_shadow');
  });

  it('includes mass_collection_shadow only when both FF_PLANNER_V2_CONTRACT_FIELDS and FF_MASS_COLLECTION_V2 are true', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'true';
    process.env.FF_MASS_COLLECTION_V2 = 'true';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).toHaveProperty('mass_collection_shadow');
    expect(result.meta).toMatchObject({
      mass_collection_shadow: massCollectionShadow,
    });
  });

  it('does not include mass_collection_shadow when FF_MASS_COLLECTION_V2=false', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'true';
    process.env.FF_MASS_COLLECTION_V2 = 'false';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).not.toHaveProperty('mass_collection_shadow');
  });

  it('includes yandex_batch_refinement meta only when both FF_PLANNER_V2_CONTRACT_FIELDS and FF_YANDEX_BATCH_REFINEMENT are true', async () => {
    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'true';
    process.env.FF_YANDEX_BATCH_REFINEMENT = 'true';

    const { controller } = createController();
    const enabledResult = await controller.plan(dto, user);

    expect(enabledResult.meta).toMatchObject({
      yandex_batch_refinement: {
        status: 'ok',
        batch_count: 1,
        failed_batches: 0,
        fallback_reasons: [],
      },
    });

    process.env.FF_PLANNER_V2_CONTRACT_FIELDS = 'false';
    process.env.FF_YANDEX_BATCH_REFINEMENT = 'true';

    const { controller: controllerWithoutContract } = createController();
    const disabledResult = await controllerWithoutContract.plan(dto, user);

    expect(disabledResult.meta).not.toHaveProperty('yandex_batch_refinement');
  });

  it('falls back to original selected when yandex batch refinement service throws', async () => {
    process.env.FF_YANDEX_BATCH_REFINEMENT = 'true';

    const { controller, schedulerService, selectedPois } = createController({
      yandexBatchRefinementError: new Error('refinement-down'),
    });

    const result = await controller.plan(dto, user);

    expect(schedulerService.buildPlan).toHaveBeenCalledWith(
      selectedPois,
      parsedIntent,
    );
    expect(result.meta.fallbacks_triggered).toContain(
      'YANDEX_BATCH_REFINEMENT_FAILED:refinement-down',
    );
  });
});
