import {
  Injectable,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import OpenAI from 'openai';

@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);
  private readonly openai: OpenAI | null;
  private readonly aiModel: string | null;

  constructor() {
    const provider =
      process.env.AI_PROVIDER?.trim().toLowerCase() || 'openrouter';

    if (provider !== 'openrouter') {
      this.openai = null;
      this.aiModel = null;
      this.logger.error('AI_PROVIDER supports only openrouter');
      return;
    }

    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const legacyOpenAiKey = process.env.OPENAI_API_KEY?.trim();
    const normalizedKey =
      apiKey ||
      (legacyOpenAiKey?.startsWith('sk-or-') ? legacyOpenAiKey : undefined);

    if (!apiKey && normalizedKey) {
      this.logger.warn(
        'OPENROUTER_API_KEY is not set, using OPENAI_API_KEY because it contains an OpenRouter token (sk-or-*)',
      );
    }

    if (!normalizedKey) {
      this.openai = null;
      this.aiModel = null;
      this.logger.error(
        'OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter (or OPENAI_API_KEY with sk-or-* token)',
      );
      return;
    }

    const baseURL =
      process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1';

    this.aiModel = process.env.AI_MODEL?.trim() || 'openai/gpt-4o-mini';

    this.openai = new OpenAI({
      apiKey: normalizedKey,
      baseURL,
      defaultHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL?.trim() || undefined,
        'X-Title': process.env.OPENROUTER_APP_NAME?.trim() || undefined,
      },
    });

    this.logger.log(
      `LLM client initialized: provider=openrouter model=${this.aiModel}`,
    );
  }

  get client(): OpenAI {
    if (!this.openai) {
      throw new ServiceUnavailableException(
        'LLM client is not configured: set AI_PROVIDER=openrouter and OPENROUTER_API_KEY',
      );
    }

    return this.openai;
  }

  get model(): string {
    if (!this.aiModel) {
      throw new ServiceUnavailableException(
        'AI model is not configured: set AI_MODEL (or use default)',
      );
    }

    return this.aiModel;
  }
}
