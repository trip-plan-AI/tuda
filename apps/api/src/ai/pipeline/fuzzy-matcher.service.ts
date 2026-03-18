import { Injectable } from '@nestjs/common';

@Injectable()
export class FuzzyMatcherService {
  public normalize(name: string): string {
    return name
      .toLowerCase()
      .replace(/["'«»]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\b(г\.|город|поселок|с\.|село|деревня|д\.)\s+/g, ' ')
      .replace(/\b(им\.|имени|памяти|в честь|memorial|named after)\b/g, '')
      .replace(
        /\b(бюджетное|государственное|автономное|учреждение|культуры|гбук|мбук)\b/g,
        '',
      )
      .replace(
        /\b(областной|краевой|муниципальный|центр|комплекс|ансамбль)\b/g,
        '',
      )
      .trim();
  }

  public calculateMatchScore(
    aiName: string,
    osmName: string,
    geoDistanceKm: number,
  ): number {
    const n1 = this.normalize(aiName);
    const n2 = this.normalize(osmName);

    if (n1 === n2) return 1.0;

    // Token overlap
    const t1 = new Set(n1.split(' ').filter((w) => w.length > 2));
    const t2 = new Set(n2.split(' ').filter((w) => w.length > 2));

    let matches = 0;
    t1.forEach((w) => {
      if (t2.has(w)) matches++;
    });

    const tokenSimilarity = matches / Math.max(t1.size, t2.size, 1);
    const diceSimilarity = this.diceCoefficient(n1, n2);

    const nameSimilarity = Math.max(tokenSimilarity, diceSimilarity);

    // geoDistanceScore: 1.0 если дистанция 0км, и 0.0 если >= 2км (более строгий фильтр)
    const geoScore = Math.max(0, 1 - geoDistanceKm / 2);

    return 0.6 * nameSimilarity + 0.4 * geoScore;
  }

  private diceCoefficient(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    if (str1.length < 2 || str2.length < 2) return 0.0;

    const bg1 = this.getBigrams(str1);
    const bg2 = this.getBigrams(str2);

    let intersectionSize = 0;
    for (const bg of bg1) {
      if (bg2.has(bg)) intersectionSize += 1;
    }

    return (2.0 * intersectionSize) / (bg1.size + bg2.size);
  }

  private getBigrams(str: string): Set<string> {
    const bigrams = new Set<string>();
    for (let i = 0; i < str.length - 1; i += 1) {
      bigrams.add(str.slice(i, i + 2));
    }
    return bigrams;
  }
}
