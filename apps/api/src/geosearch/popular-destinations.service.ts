import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { DRIZZLE } from '../db/db.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        matrix[j][i] = Math.min(matrix[j][i], matrix[j - 2][i - 2] + indicator);
      }
    }
  }
  return matrix[b.length][a.length];
}

function fuzzySubstringMatch(query: string, target: string): number {
  const q = query.toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
  const t = target.toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
  if (t.includes(q)) return 100;
  
  let bestScore = 0;
  const qLen = q.length;
  if (qLen === 0) return 0;
  
  for (let i = 0; i <= t.length - qLen; i++) {
    const sub = t.substring(i, i + qLen);
    const dist = levenshtein(q, sub);
    const maxEdits = qLen >= 5 ? 2 : (qLen >= 3 ? 1 : 0);
    if (dist <= maxEdits) {
      const score = 80 - (dist * 10);
      if (score > bestScore) bestScore = score;
    }
  }
  return bestScore;
}

@Injectable()
export class PopularDestinationsService implements OnModuleInit {
  private cache: any[] = [];

  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async onModuleInit() {
    await this.loadCache();
  }

  private async loadCache() {
    this.cache = await this.db.query.popularDestinations.findMany();
  }

  async search(query: string, limit = 5) {
    const normalized = query.trim().toLowerCase();
    if (normalized.length < 2) return [];

    if (this.cache.length === 0) {
      await this.loadCache();
    }

    const scored = this.cache.map(dest => {
      const nameScore = fuzzySubstringMatch(normalized, dest.nameRu);
      const aliasScore = dest.aliases ? fuzzySubstringMatch(normalized, dest.aliases) : 0;
      
      return {
        ...dest,
        matchScore: Math.max(nameScore, aliasScore)
      };
    }).filter(d => d.matchScore > 0);

    scored.sort((a, b) => {
      if (b.matchScore !== a.matchScore) {
        return b.matchScore - a.matchScore;
      }
      return b.popularity - a.popularity;
    });

    return scored.slice(0, limit).map((dest) => ({
      displayName: dest.displayName,
      uri: `ymapsbm1://geo?ll=${dest.lon},${dest.lat}&z=12`,
      // Add standard score for tier 0 (higher than standard geosearch results)
      score: 5.0 + dest.popularity + (dest.matchScore / 100), // ensure it's high enough to be at the top
      type: dest.type, // to differentiate on frontend if needed
    }));
  }
}
