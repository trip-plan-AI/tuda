import { LogicalIdFilterService } from './logical-id-filter.service';
import type { PoiItem } from '../types/poi.types';

describe('LogicalIdFilterService', () => {
  const createPoi = (overrides?: Partial<PoiItem>): PoiItem => ({
    id: 'kudago-101',
    name: 'Третьяковская галерея',
    address: 'Лаврушинский пер., 10, Москва',
    category: 'museum',
    coordinates: {
      lat: 55.741,
      lon: 37.62,
    },
    ...overrides,
  });

  it('creates deterministic logical_id for same source+source_id', () => {
    const service = new LogicalIdFilterService();
    const poi = createPoi();

    const first = service.attachLogicalIds([poi], 'Москва');
    const second = service.attachLogicalIds([poi], 'Москва');

    expect(first[0]?.logical_id).toBe(second[0]?.logical_id);
    expect(first[0]?.logical_id).toBe('lid:kudago:101');
  });

  it('assigns equal logical_id to equal candidates', () => {
    const service = new LogicalIdFilterService();

    const firstPoi = createPoi({ id: 'overpass-abc-1' });
    const secondPoi = createPoi({ id: 'overpass-abc-1' });

    const result = service.attachLogicalIds([firstPoi, secondPoi], 'Москва');

    expect(result[0]?.logical_id).toBe(result[1]?.logical_id);
  });

  it('falls back to normalized name + coarse coords + city when source_id is unavailable', () => {
    const service = new LogicalIdFilterService();

    const poi = createPoi({
      id: 'poiwithoutsource',
      name: '  Парк   Горького ',
      coordinates: {
        lat: 55.72888,
        lon: 37.60123,
      },
    });

    const [enriched] = service.attachLogicalIds([poi], 'Москва');

    expect(enriched?.logical_id).toBe(
      'lid:fb:парк_горького:55.729:37.601:москва',
    );
  });

  it('analyzes duplicate groups by logical_id', () => {
    const service = new LogicalIdFilterService();

    const candidates = service.attachLogicalIds(
      [
        createPoi({ id: 'kudago-1' }),
        createPoi({ id: 'kudago-1' }),
        createPoi({ id: 'overpass-2' }),
      ],
      'Москва',
    );

    const diagnostics = service.analyzeDuplicatesByLogicalId(candidates);

    expect(diagnostics).toEqual([
      {
        logical_id: 'lid:kudago:1',
        count: 2,
        ids: ['kudago-1', 'kudago-1'],
      },
    ]);
  });
});
