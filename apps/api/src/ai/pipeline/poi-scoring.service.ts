import { Injectable } from '@nestjs/common';
import { CityProfile } from './city-analyzer.service';

export interface ScoreContext {
  aiRole?: 'iconic' | 'hidden' | null;
  sitelinksCount: number;
  hasOsmOnly?: boolean;
  tags?: Record<string, string>;
  cityProfile?: CityProfile;
}

interface PoiFeatures {
  structural: {
    industrial: number;
    waterfront: number;
    nature: number;
    historic: number;
    religion: number;
  };
  experiential: {
    food: number;
    nightlife: number;
    shopping: number;
    culture: number;
    viewpoints: number;
  };
}

@Injectable()
export class PoiScoringService {
  // Список "абсолютного табу" - если это слово в названии, объект не пройдет
  private readonly HARD_BLACKLIST = [
    'ликвидаторам',
    'чернобыль',
    'афганцам',
    'погибшим',
    'жертвам',
    'аллея славы',
    'обелиск',
    'вечный огонь',
    'братская могила',
    'интернационалистам',
    'комсомольцам',
    'ударных строек',
    'участникам',
    'героям',
    'стела',
    'слава',
  ];

  public calculateScore(ctx: ScoreContext): number {
    if (!ctx.tags) return 0;

    const name = (
      ctx.tags['name'] ||
      ctx.tags['name:ru'] ||
      ctx.tags['name:en'] ||
      ''
    ).toLowerCase();

    // === 1. ЭКСТРЕННОЕ ТОРМОЖЕНИЕ (Security Layer) ===
    if (this.HARD_BLACKLIST.some((kw) => name.includes(kw))) {
      return -100;
    }

    let score = 0;

    // === 2. ПОПУЛЯРНОСТЬ (Wikidata) ===
    const wikidataImportance = Math.log(ctx.sitelinksCount + 1);
    score += Math.min(wikidataImportance * 2, 10);

    // === 3. ДНК ГОРОДА (DNA Alignment) ===
    if (ctx.cityProfile) {
      const poiFeatures = this.calculatePoiFeatures(ctx.tags);

      const structuralScore = this.calculateAlignment(
        ctx.cityProfile.structural,
        poiFeatures.structural,
      );
      const experientialScore = this.calculateAlignment(
        ctx.cityProfile.experiential,
        poiFeatures.experiential,
      );

      const dnaAlignment = structuralScore * 0.7 + experientialScore * 0.3;
      score += dnaAlignment * 15;

      score +=
        this.calculateUniquenessBoost(ctx.cityProfile.featureRarity, poiFeatures) *
        5;
    }

    // === 4. КАТЕГОРИЙНЫЙ ВЕС И МУЛЬТИПЛИКАТОРЫ ===
    const multiplier = this.getBaseCategoryMultiplier(
      ctx.tags,
      ctx.sitelinksCount,
    );
    // Множитель 0.01 превратит любой накопленный балл в ноль
    score = (score + this.calculateCategoryWeight(ctx.tags)) * multiplier;

    // === 5. AI БОНУСЫ ===
    if (score > 1) {
      // Добавляем бонусы только "живым" точкам
      if (ctx.aiRole === 'iconic') score += 12;
      if (ctx.aiRole === 'hidden') score += 8;
    }

    if (ctx.hasOsmOnly && !ctx.aiRole && score > 0) score += 1;

    return score;
  }

  private getBaseCategoryMultiplier(
    tags: Record<string, string>,
    sitelinks: number,
  ): number {
    const name = (tags['name'] || tags['name:ru'] || '').toLowerCase();
    const isMemorial =
      tags['historic'] === 'memorial' || tags['historic'] === 'monument';

    if (isMemorial) {
      // Если мемориал типовой (содержит "базовые" слова скорби)
      const genericKeywords = [
        'участникам',
        'погибшим',
        'землякам',
        'героям',
        'памяти',
      ];
      if (genericKeywords.some((kw) => name.includes(kw)) && sitelinks < 50) {
        return 0.01; // Умножаем весь скор на 0.01 - это "смерть" для объекта
      }
      return 0.3; // Обычный мемориал (не в черном списке, но и не музей)
    }

    if (tags['tourism'] === 'museum' || tags['historic'] === 'manor') return 1.5;
    if (tags['power'] === 'plant' || tags['man_made'] === 'dam') return 1.4; // ГЭС/Плотины

    return 1.0;
  }

  private calculatePoiFeatures(tags: Record<string, string>): PoiFeatures {
    return {
      structural: {
        industrial:
          tags['power'] === 'plant' ||
          tags['man_made'] === 'works' ||
          tags['industrial']
            ? 1
            : 0,
        waterfront:
          tags['waterway'] ||
          tags['natural'] === 'water' ||
          tags['leisure'] === 'marina' ||
          tags['leisure'] === 'beach'
            ? 1
            : 0,
        nature:
          tags['leisure'] === 'park' ||
          tags['natural'] === 'wood' ||
          tags['leisure'] === 'garden'
            ? 1
            : 0,
        historic:
          tags['historic'] === 'building' ||
          tags['historic'] === 'manor' ||
          tags['tourism'] === 'museum'
            ? 1
            : 0,
        religion:
          tags['religion'] || tags['amenity'] === 'place_of_worship' ? 1 : 0,
      },
      experiential: {
        food:
          tags['amenity'] === 'restaurant' ||
          tags['amenity'] === 'cafe' ||
          tags['amenity'] === 'food_court'
            ? 1
            : 0,
        nightlife:
          tags['amenity'] === 'bar' ||
          tags['amenity'] === 'pub' ||
          tags['amenity'] === 'nightclub'
            ? 1
            : 0,
        shopping:
          tags['shop'] === 'mall' ||
          tags['shop'] === 'department_store' ||
          tags['amenity'] === 'marketplace'
            ? 1
            : 0,
        culture:
          tags['tourism'] === 'museum' ||
          tags['amenity'] === 'theatre' ||
          tags['tourism'] === 'gallery'
            ? 1
            : 0,
        viewpoints:
          tags['tourism'] === 'viewpoint' || tags['man_made'] === 'tower'
            ? 1
            : 0,
      },
    };
  }

  private calculateAlignment(
    cityGroup: Record<string, number>,
    poiGroup: Record<string, number>,
  ): number {
    let alignment = 0;
    let weights = 0;

    for (const key in cityGroup) {
      if (cityGroup[key] > 0.1) {
        if (poiGroup[key] === 1) {
          alignment += cityGroup[key];
        }
        weights += cityGroup[key];
      }
    }

    return weights > 0 ? alignment / weights : 0;
  }

  private calculateUniquenessBoost(
    rarity: Record<string, number>,
    poiFeatures: PoiFeatures,
  ): number {
    let totalBoost = 0;
    let count = 0;

    const flattenedPoi: Record<string, number> = {
      ...poiFeatures.structural,
      ...poiFeatures.experiential,
    };
    for (const key in flattenedPoi) {
      if (flattenedPoi[key] === 1 && rarity[key] > 0.8) {
        totalBoost += rarity[key];
        count++;
      }
    }

    return count > 0 ? totalBoost / count : 0;
  }

  private calculateCategoryWeight(tags: Record<string, string>): number {
    let weight = 0;

    // Must-see (High Priority)
    if (tags['tourism'] === 'attraction') weight += 5;
    if (tags['tourism'] === 'museum') weight += 4;
    if (tags['historic'] === 'monument' || tags['historic'] === 'memorial')
      weight += 3;
    if (tags['natural'] === 'peak' || tags['tourism'] === 'viewpoint')
      weight += 3;

    // Standard POIs (Medium Priority)
    if (tags['leisure'] === 'park' || tags['leisure'] === 'garden') weight += 2;
    if (tags['amenity'] === 'theatre' || tags['amenity'] === 'arts_centre')
      weight += 2;
    if (tags['tourism'] === 'gallery') weight += 2;

    // Infrastructure / Food (Lower Priority as "Main Goal")
    if (tags['amenity'] === 'restaurant') weight += 1;
    if (tags['amenity'] === 'cafe') weight += 0.5;
    if (tags['amenity'] === 'bar' || tags['amenity'] === 'pub') weight += 0.5;

    return weight;
  }
}
