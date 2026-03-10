import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE } from '../db/db.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';
import { ilike, or, desc } from 'drizzle-orm';

@Injectable()
export class PopularDestinationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async search(query: string, limit = 5) {
    const normalized = query.trim().toLowerCase();
    if (normalized.length < 2) return [];

    // Prefix search for nameRu, contains search for aliases
    const results = await this.db.query.popularDestinations.findMany({
      where: or(
        ilike(schema.popularDestinations.nameRu, `${normalized}%`),
        ilike(schema.popularDestinations.aliases, `%${normalized}%`),
      ),
      orderBy: [desc(schema.popularDestinations.popularity)],
      limit,
    });

    return results.map((dest) => ({
      displayName: dest.displayName,
      uri: `ymapsbm1://geo?ll=${dest.lon},${dest.lat}&z=12`,
      // Add standard score for tier 0 (higher than standard geosearch results)
      score: 5.0 + dest.popularity, // ensure it's high enough to be at the top
      type: dest.type, // to differentiate on frontend if needed
    }));
  }
}
