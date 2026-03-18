import { Injectable, Logger } from '@nestjs/common';
import { RawOsmPoi } from './overpass-fetch.service';

export interface CityProfile {
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
  featureRarity: Record<string, number>;
  characteristics: string[];
  topCategories: string[];
  description: string;
}

@Injectable()
export class CityAnalyzerService {
  private readonly logger = new Logger(CityAnalyzerService.name);

  /**
   * Анализирует массив POI и формирует "генетический код" города.
   * Принимает любой массив объектов, у которых есть поле tags.
   */
  public analyze(pois: Array<{ tags?: Record<string, any> }>): CityProfile {
    const categories = new Map<string, number>();
    const counts = {
      industrial: 0,
      waterfront: 0,
      nature: 0,
      historic: 0,
      religion: 0,
      food: 0,
      nightlife: 0,
      shopping: 0,
      culture: 0,
      viewpoints: 0,
    };

    for (const poi of pois) {
      const tags = poi.tags || {};
      const mainCat =
        tags['tourism'] ||
        tags['historic'] ||
        tags['amenity'] ||
        tags['leisure'];
      if (mainCat) {
        categories.set(mainCat, (categories.get(mainCat) || 0) + 1);
      }

      // Structural
      if (
        tags['industrial'] ||
        tags['man_made'] === 'works' ||
        tags['power'] === 'plant'
      )
        counts.industrial++;
      if (
        tags['waterway'] ||
        tags['natural'] === 'water' ||
        tags['boat'] === 'yes' ||
        tags['leisure'] === 'marina'
      )
        counts.waterfront++;
      if (tags['historic'] || tags['heritage']) counts.historic++;
      if (tags['religion'] || tags['amenity'] === 'place_of_worship')
        counts.religion++;
      if (
        tags['leisure'] === 'park' ||
        tags['natural'] === 'wood' ||
        tags['leisure'] === 'garden'
      )
        counts.nature++;

      // Experiential
      if (
        tags['amenity'] === 'restaurant' ||
        tags['amenity'] === 'cafe' ||
        tags['amenity'] === 'food_court'
      )
        counts.food++;
      if (
        tags['amenity'] === 'bar' ||
        tags['amenity'] === 'pub' ||
        tags['amenity'] === 'nightclub'
      )
        counts.nightlife++;
      if (
        tags['shop'] === 'mall' ||
        tags['shop'] === 'department_store' ||
        tags['amenity'] === 'marketplace'
      )
        counts.shopping++;
      if (
        tags['amenity'] === 'theatre' ||
        tags['amenity'] === 'arts_centre' ||
        tags['tourism'] === 'museum'
      )
        counts.culture++;
      if (tags['tourism'] === 'viewpoint' || tags['natural'] === 'peak')
        counts.viewpoints++;
    }

    const total = pois.length || 1;

    const normalize = (val: number) => Math.min(val / (total * 0.1), 1.0); // 10% покрытия = 1.0 score

    const structural = {
      industrial: normalize(counts.industrial),
      waterfront: normalize(counts.waterfront),
      nature: normalize(counts.nature),
      historic: normalize(counts.historic),
      religion: normalize(counts.religion),
    };

    const experiential = {
      food: normalize(counts.food),
      nightlife: normalize(counts.nightlife),
      shopping: normalize(counts.shopping),
      culture: normalize(counts.culture),
      viewpoints: normalize(counts.viewpoints),
    };

    // Расчет редкости (1 - частота). Редкие категории получают более высокий балл.
    const featureRarity: Record<string, number> = {};
    const allFeatureKeys: Array<keyof typeof counts> = [
      'industrial',
      'waterfront',
      'nature',
      'historic',
      'religion',
      'food',
      'nightlife',
      'shopping',
      'culture',
      'viewpoints',
    ];
    allFeatureKeys.forEach((key) => {
      const count = counts[key] || 0;
      featureRarity[key] = 1 - count / total;
    });

    const topCategories = Array.from(categories.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    const characteristics: string[] = [];
    if (structural.industrial > 0.4)
      characteristics.push('индустриальный центр');
    if (structural.waterfront > 0.4) characteristics.push('прибрежная зона');
    if (structural.historic > 0.5) characteristics.push('исторический город');
    if (experiential.culture > 0.4) characteristics.push('культурная столица');
    if (experiential.nightlife > 0.3)
      characteristics.push('активная ночная жизнь');

    return {
      structural,
      experiential,
      featureRarity,
      characteristics,
      topCategories,
      description: `Город с профилем: ${characteristics.join(', ') || 'сбалансированная городская среда'}.`,
    };
  }
}
