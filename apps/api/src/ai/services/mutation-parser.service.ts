import { Injectable, Logger } from '@nestjs/common';
import { PointMutation } from '../types/mutations';
import { LlmClientService } from '../pipeline/llm-client.service';

const MUTATION_SYSTEM_PROMPT = `You are an AI assistant that modifies travel routes.
Extract the user's intent to add, remove, or modify places in a trip.
Return ONLY valid JSON with a "mutations" array containing objects matching this schema:

type PointMutation =
  | { type: 'ADD'; name: string; category?: string; afterPointId?: string | null }
  | { type: 'REMOVE_BY_QUERY'; query: string; timeContext?: string; limit?: number | null }
  | { type: 'REPLACE'; pointId: string; newPlaceName: string }
  | { type: 'MOVE'; pointId: string; afterPointId: string | null }
  | { type: 'OPTIMIZE_ROUTE' };

IMPORTANT RULES:
- If user wants to REMOVE/DELETE/УДАЛИТЬ a place, use REMOVE_BY_QUERY with the place name as query
- If user wants to ADD/ДОБАВИТЬ a place, use ADD with the place name
- If user wants to REPLACE a place, use REPLACE
- If user mentions optimization, use OPTIMIZE_ROUTE
- The query parameter for REMOVE_BY_QUERY should be the exact place name or searchable text

EXAMPLES:
- User: "Delete Moscow" / "Удали Москву" → { "type": "REMOVE_BY_QUERY", "query": "Moscow" }
- User: "Add café" / "Добавь кафе" → { "type": "ADD", "name": "café" }
- User: "Remove the museum" / "Удали музей" → { "type": "REMOVE_BY_QUERY", "query": "museum" }

Only output valid JSON matching { "mutations": PointMutation[] }`;

@Injectable()
export class MutationParserService {
  private readonly logger = new Logger('AI:MutationParser');

  constructor(private readonly llm: LlmClientService) {}

  async parseMutations(
    query: string,
    tripContext?: string,
  ): Promise<PointMutation[]> {
    this.logger.log(`Parsing mutations for query: "${query}"`);

    try {
      const response = await this.llm.client.chat.completions.create({
        model: this.llm.model,
        messages: [
          { role: 'system', content: MUTATION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: tripContext
              ? `Current trip context: ${tripContext}\n\nUser query: ${query}`
              : query,
          },
        ],
        response_format: { type: 'json_object' },
      });

      const content =
        response.choices[0]?.message?.content || '{"mutations": []}';
      const parsed = JSON.parse(content);
      this.logger.log(
        `Parsed mutations from LLM: ${JSON.stringify(parsed.mutations)}`,
      );

      return parsed.mutations || [];
    } catch (err) {
      this.logger.error('Failed to parse mutations', err);
      return [];
    }
  }
}
