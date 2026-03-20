import { Injectable, Logger } from '@nestjs/common';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { LlmClientService } from './llm-client.service';
import type { PlanDay, PlanDayPoint, RoutePlan, SessionMessage } from '../types/pipeline.types';

// ─── Conversational assistant ────────────────────────────────────────────────

const CHAT_SYSTEM_PROMPT = `Ты — дружелюбный ассистент для планирования маршрутов и путешествий. Ты помогаешь пользователю определиться с параметрами маршрута через диалог.

ЖЁСТКИЕ ПРАВИЛА:
1. Отвечай ТОЛЬКО на русском языке, коротко (2-4 предложения).
2. ВСЕ твои ответы должны быть направлены на уточнение или формирование маршрута. Ни при каких обстоятельствах не отвечай на вопросы вне темы путешествий.
3. Если пользователь пишет что-то не связанное с путешествиями/маршрутами — мягко но твёрдо возвращай его к теме: "Я помогаю только с планированием путешествий. Давай вернёмся к маршруту."
4. Не придумывай конкретные места или рейтинги — только уточняй предпочтения.
5. НЕ используй эмодзи.

СТИЛЬ ОБЩЕНИЯ:
- Будь тёплым и человечным, но без лишних слов. Если пользователь пишет эмоционально ("хочу отдохнуть", "устал", "мечтаю о море") — кратко поддержи и сразу направь к делу.
- Например: "Отличная идея — отдых точно поможет! Куда хочешь поехать?" или "Понимаю, солнце и море — лучшее лекарство. Давай подберём маршрут!"
- Не будь сухим ботом, но и не растекайся — максимум одно предложение эмпатии, потом сразу к маршруту.

ЛОГИКА ДИАЛОГА — последовательно выясняй недостающие параметры:
- Если нет города/направления → спроси куда хочет поехать
- Если нет количества дней → спроси на сколько дней
- Если нет бюджета → спроси примерный бюджет
- Если нет интересов → спроси что интересует (музеи, еда, природа, активности, архитектура)
- Когда есть хотя бы город + дни → предложи: "Готов построить маршрут. Напиши что-нибудь вроде «Маршрут по [город] на [N] дней» — и я всё составлю."

Если пользователь отвечает уклончиво ("любой", "не знаю", "всё равно"):
- Для города: предложи 2-3 популярных направления в зависимости от контекста
- Для интересов: предложи стандартный сбалансированный маршрут

Если маршрут уже построен (есть в контексте):
- Помоги пользователю уточнить или улучшить его
- Отвечай на вопросы про существующие точки маршрута
- Предлагай конкретные изменения: "Если хочешь добавить кафе, напиши «Добавь кафе»"`;

// ─── Route modification assistant ────────────────────────────────────────────

const MODIFY_SYSTEM_PROMPT = `Ты — редактор туристического маршрута. Тебе дан текущий маршрут (список точек с ID, названиями, днями) и запрос пользователя на изменение.

Твоя задача — понять что именно пользователь хочет изменить и вернуть скорректированный маршрут, ИСПОЛЬЗУЯ ТОЛЬКО существующие poi_id из текущего маршрута.

ПРАВИЛА:
1. Отвечай ТОЛЬКО на русском языке.
2. Используй ТОЛЬКО poi_id из списка текущих точек — никогда не придумывай новые.
3. Сохраняй порядок точек ЕСЛИ пользователь явно не просит его изменить.
4. Можно: удалять точки, менять их порядок, переносить между днями, ПОЛНОСТЬЮ ОЧИЩАТЬ маршрут.
5. Нельзя: добавлять новые poi_id, которых нет в исходном маршруте.
6. Если пользователь хочет ДОБАВИТЬ что-то новое (новое кафе, новый музей) — верни action="chat" с советом написать "Добавь [категория]".
7. Если запрос непонятен — верни action="chat" с уточняющим вопросом.
8. Если пользователь просит удалить весь маршрут / очистить всё / убрать все точки — верни action="modify" с пустым массивом days: [].
9. В остальных случаях старайся сохранить хотя бы 1 точку в каждом дне.

Верни ТОЛЬКО валидный JSON:
{
  "action": "modify" | "chat",
  "message": "текст для пользователя (что было изменено или вопрос)",
  "days": [
    { "day_number": 1, "poi_ids": ["poi_id_1", "poi_id_2"] }
  ]
}
Для action="chat" поле days можно опустить.`;

interface ModifyResult {
  type: 'modify';
  message: string;
  days: Array<{ day_number: number; poi_ids: string[] }>;
}

interface ChatResult {
  type: 'chat';
  message: string;
}

@Injectable()
export class TravelChatService {
  private readonly logger = new Logger(TravelChatService.name);

  constructor(private readonly llmClientService: LlmClientService) {}

  // ── Conversational mode (no existing route or vague intent) ─────────────

  async generateResponse(
    userMessage: string,
    history: SessionMessage[],
    routeContext?: { city?: string | null; days?: number; pointCount?: number },
  ): Promise<string> {
    const historyMessages: ChatCompletionMessageParam[] = history
      .filter((m) => m.content && m.content.trim().length > 0)
      .slice(-14)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const contextNotes: string[] = [];
    if (routeContext?.city) {
      contextNotes.push(
        `Текущий маршрут: город ${routeContext.city}, дней: ${routeContext.days ?? '?'}, точек: ${routeContext.pointCount ?? 0}.`,
      );
    }

    const systemContent =
      contextNotes.length > 0
        ? `${CHAT_SYSTEM_PROMPT}\n\nКОНТЕКСТ СЕССИИ:\n${contextNotes.join('\n')}`
        : CHAT_SYSTEM_PROMPT;

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemContent },
      ...historyMessages,
      { role: 'user', content: userMessage },
    ];

    try {
      const response = await this.llmClientService.chat(messages, {
        temperature: 0.6,
        maxTokens: 250,
      });
      return (
        response?.trim() ||
        'Расскажи подробнее — куда хочешь поехать и на сколько дней?'
      );
    } catch (error) {
      this.logger.warn(`TravelChat LLM error: ${String(error)}`);
      return 'Расскажи подробнее — куда хочешь поехать и на сколько дней?';
    }
  }

  // ── Route modification mode (existing route + free-form edit request) ───

  async modifyRoute(
    userMessage: string,
    existingPlan: RoutePlan,
  ): Promise<ModifyResult | ChatResult> {
    // Build a compact route description for the LLM
    const routeDescription = existingPlan.days
      .map((day) => {
        const points = day.points
          .map((p, i) => `  ${i + 1}. poi_id="${p.poi_id}" name="${(p.poi as any)?.name ?? 'Без названия'}" category="${(p.poi as any)?.category ?? ''}" cost=${p.estimated_cost ?? 0}`)
          .join('\n');
        return `День ${day.day_number} (${day.date ?? 'без даты'}):\n${points}`;
      })
      .join('\n\n');

    const userContent = `Текущий маршрут (город: ${existingPlan.city}):\n${routeDescription}\n\nЗапрос пользователя: "${userMessage}"`;

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: MODIFY_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];

    try {
      const raw = await this.llmClientService.chat(messages, {
        jsonMode: true,
        temperature: 0.3,
        maxTokens: 600,
      });

      const parsed = JSON.parse(raw || '{}') as {
        action?: string;
        message?: string;
        days?: Array<{ day_number?: number; poi_ids?: string[] }>;
      };

      if (parsed.action === 'modify' && Array.isArray(parsed.days)) {
        // Allow explicit clear-all: LLM returned empty days array
        if (parsed.days.length === 0) {
          return {
            type: 'modify',
            message: parsed.message ?? 'Маршрут удален.',
            days: [],
          };
        }

        // Validate that all returned poi_ids exist in the original plan
        const validPoiIds = new Set(
          existingPlan.days.flatMap((d) => d.points.map((p) => p.poi_id)),
        );

        const sanitizedDays = parsed.days
          .filter(
            (d) =>
              typeof d.day_number === 'number' && Array.isArray(d.poi_ids),
          )
          .map((d) => ({
            day_number: d.day_number!,
            poi_ids: (d.poi_ids ?? []).filter((id) => validPoiIds.has(id)),
          }))
          .filter((d) => d.poi_ids.length > 0);

        if (sanitizedDays.length > 0) {
          return {
            type: 'modify',
            message: parsed.message ?? 'Маршрут скорректирован.',
            days: sanitizedDays,
          };
        }
      }

      return {
        type: 'chat',
        message:
          parsed.message ??
          'Уточни, пожалуйста, что именно хочешь изменить в маршруте.',
      };
    } catch (error) {
      this.logger.warn(`TravelChat modifyRoute LLM error: ${String(error)}`);
      return {
        type: 'chat',
        message: 'Уточни, пожалуйста, что именно хочешь изменить в маршруте.',
      };
    }
  }

  // ── Reconstruct RoutePlan from LLM-provided poi_id lists ─────────────────

  reconstructPlan(
    original: RoutePlan,
    modifyDays: Array<{ day_number: number; poi_ids: string[] }>,
  ): RoutePlan {
    // Build lookup map from the original plan
    const pointMap = new Map<string, PlanDayPoint>();
    const dayMeta = new Map<
      number,
      { date: string; day_start_time: string; day_end_time: string }
    >();

    for (const day of original.days) {
      dayMeta.set(day.day_number, {
        date: day.date,
        day_start_time: day.day_start_time,
        day_end_time: day.day_end_time,
      });
      for (const point of day.points) {
        pointMap.set(point.poi_id, point);
      }
    }

    const newDays: PlanDay[] = modifyDays.map((mod, idx) => {
      const meta = dayMeta.get(mod.day_number) ?? {
        date: original.days[idx]?.date ?? '',
        day_start_time: original.days[0]?.day_start_time ?? '09:00',
        day_end_time: original.days[0]?.day_end_time ?? '22:00',
      };

      // Rebuild points keeping original data, recalculate times sequentially
      let currentMinutes = this.timeToMinutes(meta.day_start_time);
      const points: PlanDayPoint[] = mod.poi_ids
        .flatMap((id, i) => {
          const original_point = pointMap.get(id);
          if (!original_point) return [];

          const transitMins =
            i === 0 ? 0 : (original_point.travel_from_prev_min ?? 15);
          const arrivalMin = currentMinutes + transitMins;
          const durationMin = original_point.visit_duration_min || 60;
          const departureMin = arrivalMin + durationMin;
          currentMinutes = departureMin;

          const point: PlanDayPoint = {
            ...original_point,
            order: i,
            arrival_time: this.minutesToTime(arrivalMin),
            departure_time: this.minutesToTime(departureMin),
          };
          if (i > 0) point.travel_from_prev_min = transitMins;
          return [point];
        });

      const dayBudget = points.reduce(
        (s, p) => s + (p.estimated_cost ?? 0),
        0,
      );

      return {
        day_number: idx + 1, // renumber sequentially
        date: meta.date,
        day_start_time: meta.day_start_time,
        day_end_time: meta.day_end_time,
        day_budget_estimated: dayBudget,
        points,
      };
    });

    return {
      ...original,
      days: newDays,
      total_budget_estimated: newDays.reduce(
        (s, d) => s + d.day_budget_estimated,
        0,
      ),
    };
  }

  private timeToMinutes(value: string | undefined | null): number {
    if (!value) return 9 * 60;
    const parts = value.split(':');
    const h = parseInt(parts[0] ?? '9', 10);
    const m = parseInt(parts[1] ?? '0', 10);
    return h * 60 + (isNaN(m) ? 0 : m);
  }

  private minutesToTime(total: number): string {
    const clamped = Math.max(0, Math.min(23 * 60 + 59, total));
    const h = Math.floor(clamped / 60);
    const m = clamped % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
