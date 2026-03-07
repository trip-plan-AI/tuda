import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import OpenAI from 'openai';

@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);
  private readonly openai: OpenAI;
  private readonly aiModel: string;

  constructor() {
    const provider = process.env.AI_PROVIDER?.trim().toLowerCase();

    if (provider !== 'openrouter') {
      throw new InternalServerErrorException(
        'AI_PROVIDER must be set to openrouter',
      );
    }

    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      throw new InternalServerErrorException(
        'OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter',
      );
    }

    const baseURL =
      process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1';

    this.aiModel = process.env.AI_MODEL?.trim() || 'openai/gpt-4o-mini';

    this.openai = new OpenAI({
      apiKey,
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
    return this.openai;
  }

  get model(): string {
    return this.aiModel;
  }
}
