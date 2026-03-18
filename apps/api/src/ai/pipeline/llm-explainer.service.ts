import { Injectable, Logger, Inject } from '@nestjs/common';
import { LlmClientService } from './llm-client.service';
import { CityProfile } from './city-analyzer.service';
import { createHash } from 'crypto';
import { DRIZZLE } from '../../db/db.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { explanationCache } from '../../db/city-dataset.schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class LlmExplainerService {
  private readonly logger = new Logger(LlmExplainerService.name);

  constructor(
    private readonly llmClient: LlmClientService,
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Генерирует увлекательное повествование для маршрута, опираясь на City DNA.
   */
  public async explainRoute(
    city: string,
    routeDays: any[],
    cityProfile?: CityProfile,
  ): Promise<string> {
    // 1. Генерируем хэш маршрута для кэширования
    const allPoiIds = routeDays
      .flatMap((d) =>
        d.points.map((p: any) => p.id || p.osmId || (p.poi && p.poi.id)),
      )
      .sort()
      .join(',');
    const routeHash = createHash('md5')
      .update(`${city}:${allPoiIds}`)
      .digest('hex');

    // 2. Проверяем кэш
    try {
      const cached = await this.db.query.explanationCache.findFirst({
        where: eq(explanationCache.routeHash, routeHash),
      });
      if (cached) {
        this.logger.log(`Using cached explanation for route in ${city}`);
        return cached.explanation;
      }
    } catch (e) {
      this.logger.warn('Failed to read explanation cache', e);
    }

    const dnaContext = cityProfile
      ? `
КОНТЕКСТ ГОРОДА (City DNA):
- Характер: ${cityProfile.characteristics.join(', ')}
- Описание: ${cityProfile.description}
- Доминирующие черты: ${Object.entries(cityProfile.structural)
          .filter(([_, v]) => v > 0.5)
          .map(([k]) => k)
          .join(', ')}
`
      : '';

    const systemPrompt = `Ты — профессиональный тревел-колумнист и эксперт по городскому сторителлингу.
Твоя задача: написать увлекательное вступление и описание маршрута.

ПРАВИЛА:
1. Вступление: Начни с короткого, яркого абзаца, который передает "дух" города (используй City DNA).
2. Логика переходов: Объясни, почему маршрут построен именно так (например: "От индустриальных гигантов мы перейдем к уютной набережной...").
3. Скрытые жемчужины: Подчеркни 1-2 места, которые делают этот маршрут уникальным.
4. Стиль: Живой, вдохновляющий, без клише типа "город контрастов".
5. ЗАПРЕЩЕНО менять порядок точек или добавлять свои.

${dnaContext}`;

    const routeDescription = routeDays
      .map((day) => {
        const points = day.points
          .map((p: any) => {
            const name = p.name || (p.poi && p.poi.name);
            const cat = p.category || (p.poi && p.poi.category);
            return `- ${name} (${cat})`;
          })
          .join('\n');
        return `День ${day.day_number}:\n${points}`;
      })
      .join('\n\n');

    const userPrompt = `Город: ${city}\n\nМаршрут:\n${routeDescription}\n\nНапиши увлекательный сторителлинг для этого путешествия.`;

    try {
      const response = await this.llmClient.client.chat.completions.create({
        model: this.llmClient.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
      });

      const explanation =
        response.choices[0]?.message?.content || 'Приятного путешествия!';

      // 3. Сохраняем в кэш
      await this.db
        .insert(explanationCache)
        .values({
          routeHash,
          explanation,
        })
        .onConflictDoNothing();

      return explanation;
    } catch (e) {
      this.logger.error('Failed to generate route explanation', e);
      return `Ваш маршрут по городу ${city} готов. Он оптимально спланирован с учетом характера города.`;
    }
  }
}
