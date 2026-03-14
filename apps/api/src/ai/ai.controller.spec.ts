import { AiController } from './ai.controller';
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
import type { FilteredPoi, PoiItem } from './types/poi.types';

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
    budget_per_person: 10000,
    poi_count_requested: null,
    min_restaurants: null,
    min_cafes: null,
    max_poi: null,
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
    policy_version: 'v2',
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
    logicalSelectorResult?: {
      selected_ids: string[];
      target: number;
      selected_count: number;
      fallback_reason?: string;
    };
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
    const logicalIdSelectorService = {
      selectIds: jest
        .fn()
        .mockResolvedValue(
          options?.logicalSelectorResult ?? {
            selected_ids: poiItems.map((poi) => poi.id),
            target: poiItems.length,
            selected_count: poiItems.length,
          },
        ),
    };

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
      logicalIdSelectorService as never,
    );

    return {
      controller,
      schedulerService,
      semanticFilterService,
      logicalIdSelectorService,
      yandexBatchRefinementService,
      selectedPois,
    };
  };

  afterEach(() => {
    delete process.env.FF_INTENT_ROUTER_V2;
    delete process.env.FF_POLICY_CALC_V2;
    delete process.env.FF_LOGICAL_ID_FILTER_V2;
    delete process.env.FF_VECTOR_PREFILTER_REDIS;
    delete process.env.FF_DETERMINISTIC_PLANNER_V2;
    delete process.env.FF_MASS_COLLECTION_V2;
    delete process.env.AI_VECTOR_TOPK;
    jest.clearAllMocks();
  });

  it('plan stream emits plan_started as first event', async () => {
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
        planner_version: 'v2',
      },
    });
    expect((firstEvent.data as { request_id?: string }).request_id).toEqual(
      expect.any(String),
    );

    handlers.get('close')?.();
  });

  it('returns always-on meta blocks for active control flow by default', async () => {
    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).toHaveProperty('intent_router');
    expect(result.meta).toHaveProperty('policy_snapshot');
    expect(result.meta).toHaveProperty('logical_id_shadow');
    expect(result.meta).toHaveProperty('logical_selector');
    expect(result.meta).toHaveProperty('vector_prefilter_shadow');
    expect(result.meta).toHaveProperty('deterministic_planner_shadow');
    expect(result.meta).toHaveProperty('mass_collection_shadow');
    expect(result.meta).toHaveProperty('parsed_intent');
    expect(result.meta).toHaveProperty('steps_duration_ms');
    expect(result.meta).toHaveProperty('poi_counts');
    expect(result.meta).toHaveProperty('fallbacks_triggered');
  });

  it('includes intent_router meta regardless of removed FF flags', async () => {
    process.env.FF_INTENT_ROUTER_V2 = 'false';

    const { controller } = createController({ withFallbacks: true });

    const result = await controller.plan(dto, user);

    expect(result.meta).toMatchObject({
      intent_router: {
        action_type: 'ADD_DAYS',
        confidence: 0.75,
        target_poi_id: null,
        route_mode: 'targeted_mutation',
      },
    });
  });

  it('includes policy_snapshot regardless of removed FF_POLICY_CALC_V2', async () => {
    process.env.FF_POLICY_CALC_V2 = 'false';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).toMatchObject({
      policy_snapshot: {
        required_capacity: 12,
        food_policy: {
          food_mode: 'default',
          food_interval_hours: 4,
        },
        policy_version: 'v2',
      },
    });
  });

  it('includes logical_id_shadow regardless of removed FF_LOGICAL_ID_FILTER_V2', async () => {
    process.env.FF_LOGICAL_ID_FILTER_V2 = 'false';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).toMatchObject({
      logical_id_shadow: {
        total_candidates: 2,
        duplicates_groups: 1,
        duplicates_total: 2,
      },
    });
  });

  it('includes vector_prefilter_shadow regardless of removed FF_VECTOR_PREFILTER_REDIS', async () => {
    process.env.FF_VECTOR_PREFILTER_REDIS = 'false';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).toMatchObject({
      vector_prefilter_shadow: {
        status: 'ok',
        total_candidates: 2,
        selected_count: 2,
        top_k: 200,
      },
    });
  });

  it('includes deterministic_planner_shadow regardless of removed FF_DETERMINISTIC_PLANNER_V2', async () => {
    process.env.FF_DETERMINISTIC_PLANNER_V2 = 'false';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

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

  it('includes mass_collection_shadow regardless of removed FF_MASS_COLLECTION_V2', async () => {
    process.env.FF_MASS_COLLECTION_V2 = 'false';

    const { controller } = createController();

    const result = await controller.plan(dto, user);

    expect(result.meta).toMatchObject({
      mass_collection_shadow: massCollectionShadow,
    });
  });

  it('always includes yandex_batch_refinement meta', async () => {
    const { controller } = createController();
    const result = await controller.plan(dto, user);

    expect(result.meta).toMatchObject({
      yandex_batch_refinement: {
        status: 'ok',
        batch_count: 1,
        failed_batches: 0,
        fallback_reasons: [],
      },
    });
  });

  it('falls back to original selected when yandex batch refinement service throws', async () => {
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

  it('applies logical selector ids to semantic downstream pool and returns logical_selector diagnostics', async () => {
    const logicalSelectorResult = {
      selected_ids: [],
      target: 2,
      selected_count: 0,
      fallback_reason: 'LOGICAL_SELECTOR_INVALID:NON_ARRAY_RESPONSE',
    };
    const { controller, semanticFilterService, logicalIdSelectorService } =
      createController({ logicalSelectorResult });

    const result = await controller.plan(dto, user);

    expect(logicalIdSelectorService.selectIds).toHaveBeenCalledWith({
      candidates: [
        {
          id: 'kudago-10',
          name: 'ГМИИ им. Пушкина',
          category: 'museum',
        },
        {
          id: 'kudago-10',
          name: 'ГМИИ им. Пушкина',
          category: 'museum',
        },
      ],
      required_capacity: 12,
      food_policy: {
        food_mode: 'default',
        food_interval_hours: 4,
      },
    });
    expect(semanticFilterService.select).toHaveBeenCalledWith(
      [],
      parsedIntent,
      expect.any(Array),
    );
    expect(result.meta).toMatchObject({
      logical_selector: {
        target: 2,
        selected_count: 0,
        fallback_reason: 'LOGICAL_SELECTOR_INVALID:NON_ARRAY_RESPONSE',
      },
      poi_counts: {
        yandex_raw: 2,
        after_logical_selector: 0,
      },
    });
  });
});

describe('AiController targeted mutations (phase 3)', () => {
  const user = { id: 'user-1' };
  const dto: AiPlanRequestDto = {
    user_query: 'Обнови текущий маршрут',
  };

  const baseIntent: ParsedIntent = {
    city: 'Москва',
    days: 2,
    budget_total: 10000,
    budget_per_day: 5000,
    budget_per_person: 10000,
    poi_count_requested: null,
    min_restaurants: null,
    min_cafes: null,
    max_poi: null,
    party_type: 'solo',
    party_size: 1,
    categories: ['museum', 'attraction'],
    excluded_categories: [],
    radius_km: 5,
    start_time: '10:00',
    end_time: '20:00',
    preferences_text: 'спокойный темп',
  };

  const basePolicy: PolicySnapshot = {
    required_capacity: 10,
    food_policy: { food_mode: 'default', food_interval_hours: 4 },
    user_persona_summary: 'solo, культурная программа',
    policy_version: 'v2',
  };

  const massCollectionShadow: MassCollectionShadowMeta = {
    provider_stats: [],
    totals: { before_dedup: 0, after_dedup: 0, returned: 0 },
  };

  const poi = (
    id: string,
    name: string,
    category: PoiItem['category'],
    lat: number,
    lon: number,
    working_hours?: string,
  ): FilteredPoi => ({
    id,
    name,
    category,
    address: `${name}, Москва`,
    coordinates: { lat, lon },
    description: `Описание ${name}`,
    working_hours,
  });

  const createController = (options: {
    historyRoutePlan?: RoutePlan;
    intentRouterDecision: {
      action_type: 'REMOVE_POI' | 'REPLACE_POI' | 'ADD_DAYS' | 'NEW_ROUTE';
      confidence: number;
      target_poi_id: string | null;
      route_mode: 'targeted_mutation' | 'full_rebuild';
    };
    selectedPois: FilteredPoi[];
    rawPois?: PoiItem[];
    buildPlanResult?: RoutePlan;
    rebuildDayResult?: RoutePlan['days'][number];
  }) => {
    const routeMessage = options.historyRoutePlan
      ? [
          {
            role: 'assistant' as const,
            content: JSON.stringify(options.historyRoutePlan),
          },
        ]
      : [];

    const aiSessionsService = {
      getOrCreateForPlan: jest.fn().mockResolvedValue({
        id: 'session-1',
        messages: routeMessage,
      }),
      saveMessages: jest.fn().mockResolvedValue(undefined),
    };

    const orchestratorService = {
      parseIntent: jest.fn().mockResolvedValue(baseIntent),
    };

    const providerSearchService = {
      fetchAndFilter: jest.fn().mockResolvedValue({
        pois: options.rawPois ?? options.selectedPois,
        shadowDiagnostics: massCollectionShadow,
      }),
    };

    const semanticFilterService = {
      select: jest.fn().mockResolvedValue(options.selectedPois),
    };

    const yandexBatchRefinementService = {
      refineSelectedInBatches: jest.fn(),
      chooseReplacementAlternative: jest
        .fn()
        .mockImplementation(async (candidates: FilteredPoi[]) => candidates[0] ?? null),
    };

    const schedulerService = {
      buildPlan: jest.fn().mockReturnValue(
        options.buildPlanResult ?? {
          city: 'Москва',
          total_budget_estimated: 5000,
          days: [],
        },
      ),
      rebuildSingleDayPlan: jest.fn().mockReturnValue(
        options.rebuildDayResult ?? {
          day_number: 1,
          date: '2026-03-10',
          day_budget_estimated: 1000,
          day_start_time: '10:00',
          day_end_time: '20:00',
          points: [],
        },
      ),
    };

    const intentRouterService = {
      route: jest.fn().mockResolvedValue(options.intentRouterDecision),
    };

    const policyService = {
      calculatePolicySnapshot: jest.fn().mockReturnValue(basePolicy),
    };

    const vectorPrefilterService = {
      runShadowPrefilter: jest.fn().mockResolvedValue({
        status: 'ok',
        total_candidates: options.selectedPois.length,
        selected_count: options.selectedPois.length,
        top_k: 200,
      }),
    };

    const deterministicPlannerService = {
      buildInputHash: jest.fn().mockReturnValue('hash-1'),
      buildDecisionLogSummary: jest.fn().mockReturnValue({
        days_count: 1,
        points_total: 1,
        unique_poi_count: 1,
        duplicate_poi_count: 0,
      } satisfies DeterministicPlannerDecisionSummary),
    } as unknown as DeterministicPlannerService;
    const logicalIdSelectorService = {
      selectIds: jest.fn().mockResolvedValue({
        selected_ids: (options.rawPois ?? options.selectedPois).map((item) => item.id),
        target: (options.rawPois ?? options.selectedPois).length,
        selected_count: (options.rawPois ?? options.selectedPois).length,
      }),
    };

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
      new LogicalIdFilterService(),
      vectorPrefilterService as never,
      deterministicPlannerService,
      yandexBatchRefinementService as never,
      logicalIdSelectorService as never,
    );

    return {
      controller,
      schedulerService,
      yandexBatchRefinementService,
    };
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('REMOVE_POI: удаляет точку и пересобирает день', async () => {
    const p1 = poi('p1', 'Третьяковка', 'museum', 55.741, 37.62);
    const p2 = poi('p2', 'Парк Горького', 'park', 55.729, 37.601);

    const existingPlan: RoutePlan = {
      city: 'Москва',
      total_budget_estimated: 2000,
      days: [
        {
          day_number: 1,
          date: '2026-03-10',
          day_budget_estimated: 2000,
          day_start_time: '10:00',
          day_end_time: '20:00',
          points: [
            {
              poi_id: 'p1',
              poi: p1,
              order: 1,
              arrival_time: '10:00',
              departure_time: '11:00',
              visit_duration_min: 60,
              estimated_cost: 1000,
            },
            {
              poi_id: 'p2',
              poi: p2,
              order: 2,
              arrival_time: '11:30',
              departure_time: '12:30',
              visit_duration_min: 60,
              estimated_cost: 1000,
            },
          ],
        },
      ],
    };

    const rebuiltDay: RoutePlan['days'][number] = {
      ...existingPlan.days[0],
      points: [
        {
          poi_id: 'p2',
          poi: p2,
          order: 1,
          arrival_time: '10:00',
          departure_time: '11:00',
          visit_duration_min: 60,
          estimated_cost: 1000,
        },
      ],
    };

    const { controller, schedulerService } = createController({
      historyRoutePlan: existingPlan,
      intentRouterDecision: {
        action_type: 'REMOVE_POI',
        confidence: 0.9,
        target_poi_id: 'p1',
        route_mode: 'targeted_mutation',
      },
      selectedPois: [p1, p2],
      rebuildDayResult: rebuiltDay,
    });

    const result = await controller.plan(dto, user);

    expect(schedulerService.rebuildSingleDayPlan).toHaveBeenCalled();
    expect(result.route_plan.days[0].points.map((point) => point.poi_id)).toEqual(['p2']);
    expect(result.meta).toMatchObject({
      mutation_applied: true,
      mutation_type: 'REMOVE_POI',
    });
  });

  it('REMOVE_POI: fallback при target not found', async () => {
    const p1 = poi('p1', 'Третьяковка', 'museum', 55.741, 37.62);
    const existingPlan: RoutePlan = {
      city: 'Москва',
      total_budget_estimated: 1000,
      days: [
        {
          day_number: 1,
          date: '2026-03-10',
          day_budget_estimated: 1000,
          day_start_time: '10:00',
          day_end_time: '20:00',
          points: [
            {
              poi_id: 'p1',
              poi: p1,
              order: 1,
              arrival_time: '10:00',
              departure_time: '11:00',
              visit_duration_min: 60,
              estimated_cost: 1000,
            },
          ],
        },
      ],
    };

    const fallbackPlan: RoutePlan = {
      city: 'Москва',
      total_budget_estimated: 5000,
      days: [],
    };

    const { controller, schedulerService } = createController({
      historyRoutePlan: existingPlan,
      intentRouterDecision: {
        action_type: 'REMOVE_POI',
        confidence: 0.9,
        target_poi_id: 'missing-poi',
        route_mode: 'targeted_mutation',
      },
      selectedPois: [p1],
      buildPlanResult: fallbackPlan,
    });

    const result = await controller.plan(dto, user);

    expect(schedulerService.buildPlan).toHaveBeenCalled();
    expect(result.route_plan).toEqual(fallbackPlan);
    expect(result.meta).toMatchObject({
      mutation_applied: false,
      mutation_type: 'REMOVE_POI',
      mutation_fallback_reason: 'TARGET_NOT_FOUND',
    });
    expect(result.meta.fallbacks_triggered).toContain(
      'TARGETED_MUTATION_REMOVE_FALLBACK:TARGET_NOT_FOUND',
    );
  });

  it('ADD_DAYS: добавляет только новые дни без дублей used poi', async () => {
    const p1 = poi('p1', 'Третьяковка', 'museum', 55.741, 37.62);
    const p2 = poi('p2', 'ВДНХ', 'attraction', 55.826, 37.637);
    const p3 = poi('p3', 'Царицыно', 'park', 55.614, 37.683);

    const existingPlan: RoutePlan = {
      city: 'Москва',
      total_budget_estimated: 2000,
      days: [
        {
          day_number: 1,
          date: '2026-03-10',
          day_budget_estimated: 2000,
          day_start_time: '10:00',
          day_end_time: '20:00',
          points: [
            {
              poi_id: 'p1',
              poi: p1,
              order: 1,
              arrival_time: '10:00',
              departure_time: '11:00',
              visit_duration_min: 60,
              estimated_cost: 1000,
            },
          ],
        },
      ],
    };

    const newDaysPlan: RoutePlan = {
      city: 'Москва',
      total_budget_estimated: 3000,
      days: [
        {
          day_number: 1,
          date: '2026-03-11',
          day_budget_estimated: 1500,
          day_start_time: '10:00',
          day_end_time: '20:00',
          points: [
            {
              poi_id: 'p2',
              poi: p2,
              order: 1,
              arrival_time: '10:00',
              departure_time: '11:00',
              visit_duration_min: 60,
              estimated_cost: 700,
            },
          ],
        },
      ],
    };

    const { controller, schedulerService } = createController({
      historyRoutePlan: existingPlan,
      intentRouterDecision: {
        action_type: 'ADD_DAYS',
        confidence: 0.9,
        target_poi_id: null,
        route_mode: 'targeted_mutation',
      },
      selectedPois: [p1, p2, p3],
      buildPlanResult: newDaysPlan,
    });

    const result = await controller.plan(dto, user);

    const schedulerCandidates = (schedulerService.buildPlan as jest.Mock).mock.calls[0][0] as FilteredPoi[];
    expect(schedulerCandidates.map((item) => item.id)).toEqual(expect.arrayContaining(['p2', 'p3']));
    expect(schedulerCandidates.map((item) => item.id)).not.toContain('p1');
    expect(result.route_plan.days).toHaveLength(2);
    expect(result.route_plan.days[1].points[0]?.poi_id).toBe('p2');
    expect(result.meta).toMatchObject({
      mutation_applied: true,
      mutation_type: 'ADD_DAYS',
    });
  });

  it('REPLACE_POI: выбирает альтернативу из ближайших с учетом working_hours', async () => {
    const p1 = poi('p1', 'Старая точка', 'museum', 55.75, 37.61);
    const altOpen = poi('alt-open', 'Новая точка', 'museum', 55.751, 37.611, '09:00-20:00');
    const altClosed = poi('alt-closed', 'Закрытая точка', 'museum', 55.7505, 37.6105, '22:00-23:00');

    const existingPlan: RoutePlan = {
      city: 'Москва',
      total_budget_estimated: 1000,
      days: [
        {
          day_number: 1,
          date: '2026-03-10',
          day_budget_estimated: 1000,
          day_start_time: '10:00',
          day_end_time: '20:00',
          points: [
            {
              poi_id: 'p1',
              poi: p1,
              order: 1,
              arrival_time: '10:00',
              departure_time: '11:00',
              visit_duration_min: 60,
              estimated_cost: 1000,
            },
          ],
        },
      ],
    };

    const rebuiltDay: RoutePlan['days'][number] = {
      ...existingPlan.days[0],
      points: [
        {
          poi_id: 'alt-open',
          poi: altOpen,
          order: 1,
          arrival_time: '10:00',
          departure_time: '11:00',
          visit_duration_min: 60,
          estimated_cost: 1200,
        },
      ],
    };

    const { controller, schedulerService, yandexBatchRefinementService } = createController({
      historyRoutePlan: existingPlan,
      intentRouterDecision: {
        action_type: 'REPLACE_POI',
        confidence: 0.9,
        target_poi_id: 'p1',
        route_mode: 'targeted_mutation',
      },
      selectedPois: [p1, altOpen, altClosed],
      rebuildDayResult: rebuiltDay,
    });

    (yandexBatchRefinementService.chooseReplacementAlternative as jest.Mock).mockResolvedValue(
      altOpen,
    );

    const result = await controller.plan(dto, user);

    const candidates =
      (yandexBatchRefinementService.chooseReplacementAlternative as jest.Mock).mock.calls[0][0] as
        | FilteredPoi[]
        | undefined;
    expect(candidates?.map((item) => item.id)).toEqual(['alt-open']);
    expect(schedulerService.rebuildSingleDayPlan).toHaveBeenCalled();
    expect(result.meta).toMatchObject({
      mutation_applied: true,
      mutation_type: 'REPLACE_POI',
    });
  });
});
