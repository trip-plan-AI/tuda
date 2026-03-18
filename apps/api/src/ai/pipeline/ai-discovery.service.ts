import { Injectable, Logger } from '@nestjs/common';
import { LlmClientService } from './llm-client.service';
import { CityProfile } from './city-analyzer.service';
import { RawOsmPoi } from './overpass-fetch.service';

export interface AiPlace {
  name: string;
  role: 'culture' | 'nature' | 'activity' | 'food' | 'iconic' | 'hidden';
  reason: string;
}

export interface AiDiscoveryResult {
  city: string;
  iconic: AiPlace[];
  hidden: AiPlace[];
}

@Injectable()
export class AiDiscoveryService {
  private readonly logger = new Logger(AiDiscoveryService.name);

  constructor(private readonly llmClientService: LlmClientService) {}

  /**
   * Выбирает лучшие места из списка реальных кандидатов.
   */
  public async curatePlaces(
    city: string,
    candidates: RawOsmPoi[],
    cityProfile: CityProfile,
  ): Promise<AiDiscoveryResult | null> {
    this.logger.log(`Curating ${candidates.length} places for ${city}...`);

    const candidateList = candidates
      .map(
        (c, i) =>
          `${i + 1}. ${c.name} (категория: ${c.tags.tourism || c.tags.historic || c.tags.amenity || 'poi'})`,
      )
      .join('\n');

    const systemPrompt = `### ROLE
Ты — экспертный travel-аналитик и гид-сомелье мирового уровня. Твоя задача — спроектировать "живой" маршрут, отражающий подлинный дух города.

### TASK
0. ПРОВЕРКА ГОРОДА: Если город "${city}" тебе не знаком, не существует или ты не уверен в его достопримечательностях — верни пустые списки. НЕ ВЫДУМЫВАЙ объекты.
1. ОПРЕДЕЛИ 3 главных архетипа этого города (напр.: 'Индустриальный гигант', 'Купеческий центр', 'Волжская Венеция').
2. ВЫБЕРИ из предоставленного списка (ID: Название) объекты, которые отражают ЭНЕРГИЮ и ЖИЗНЬ этих архетипов.
   - Нам нужны места, где турист может что-то УВИДЕТЬ, ПОЧУВСТВОВАТЬ или УЗНАТЬ (ГЭС, шлюзы, шедевры архитектуры, живые набережные).
3. КАТЕГОРИЧЕСКИ ИГНОРИРУЙ "Символические суррогаты":
   - Если архетип "Индустриальный" — ищи саму ГЭС или завод. НЕ выбирай памятники строителям или стелы "Слава Труду".
   - Если архетип "История" — ищи усадьбу или музей. НЕ выбирай типовые обелиски, вечные огни или аллеи славы.
4. ПРОВЕРЬ ГЕОГРАФИЮ: Игнорируй объекты за пределами города или в других странах (даже при совпадении названий). Твои "hidden_gems" ДОЛЖНЫ находиться строго в городе "${city}".
5. ТЕГ [Clstr:N]: Означает географическую близость. Старайся охватить разные кластеры для разнообразия маршрута.
6. HIDDEN GEMS: Если в списке нет ключевого объекта города (напр. ГЭС), добавь его в "hidden_gems".

### SELECTION CRITERIA (Strict Rules)
1. ПРИОРИТЕТ "ЖИВЫЕ МАРКЕРЫ":
   - Инженерная эстетика (ГЭС, плотины, маяки, шлюзы).
   - Архитектурная идентичность (модерн, конструктивизм, особняки).
   - Объекты Genius Loci (дух места).
2. ЖЕСТКИЙ BAN (0 баллов):
   - Любые слова: "Обелиск", "Слава", "Участникам", "Мемориал", "Погибшим", "Вечный огонь", "Ленину".
   - Типовые советские памятники-танки, пушки и бетонные стелы — ЗАПРЕЩЕНЫ, если они не являются мировыми шедеврами.
3. БАЛАНС КАТЕГОРИЙ:
   - Культура/Технологии/Архитектура: 60%
   - Активность/Природа/Набережные: 20%
   - Уникальный гастро-опыт: 20%

### OUTPUT
Верни СТРОГО JSON. Если город неизвестен, верни: {"city": "${city}", "selected": [], "hidden_gems": []}.
Для каждого объекта в "selected" укажи ID и краткое обоснование связи с АРХЕТИПОМ.`;

    const userPrompt = `Контекст города: ${cityProfile.description}
Приоритеты: ${cityProfile.characteristics.join(', ')}

Список кандидатов (ID: Название):
${candidateList}

Верни JSON формат:
{
  "city": "${city}",
  "selected": [{ "id": "номер из списка", "reason": "почему подходит архетипу" }],
  "hidden_gems": [{ "name": "название объекта", "reason": "почему его нет в списке, но он важен" }]
}`;

    try {
      const response =
        await this.llmClientService.client.chat.completions.create({
          model: this.llmClientService.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
        });

      const content = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(content);

      return {
        city: parsed.city || city,
        iconic: (parsed.selected || []).map((s: any) => {
          const idx = parseInt(s.id) - 1;
          const candidate = candidates[idx];
          return {
            name: candidate ? candidate.name : `Object ${s.id}`,
            role: 'iconic',
            reason: s.reason,
          };
        }),
        hidden: (parsed.hidden_gems || []).map((h: any) => ({
          name: h.name,
          role: 'hidden',
          reason: h.reason,
        })),
      };
    } catch (e) {
      this.logger.error(`Curation failed for ${city}`, e);
      return null;
    }
  }

  /**
   * Устаревший метод: генерирует названия мест "из головы".
   * Оставлен для обратной совместимости, но рекомендуется использовать curatePlaces.
   */
  public async discoverPlaces(
    city: string,
    description: string,
  ): Promise<AiDiscoveryResult | null> {
    const systemPrompt = `Ты — экспертный travel-аналитик. Твоя задача — предложить 5 знаковых и 3 скрытых места в городе. 
    Если город тебе не знаком или не существует, верни пустые списки. НЕ ВЫДУМЫВАЙ объекты.`;
    const userPrompt = `Город: ${city}. Описание: ${description}. Верни JSON: { "city": "${city}", "iconic": [], "hidden": [] }`;

    try {
      const response =
        await this.llmClientService.client.chat.completions.create({
          model: this.llmClientService.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
        });

      const content = response.choices[0]?.message?.content || '{}';
      return JSON.parse(content) as AiDiscoveryResult;
    } catch (e) {
      this.logger.error(`Discovery failed for ${city}`, e);
      return null;
    }
  }
}
