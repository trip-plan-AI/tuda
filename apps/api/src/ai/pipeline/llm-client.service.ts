import {
  Injectable,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);
  private readonly openai: OpenAI | null;
  private readonly aiModel: string | null;
  private readonly yandexApiKey: string | null;
  private readonly yandexFolderId: string | null;

  constructor() {
    // OpenRouter / OpenAI configuration
    const apiKey =
      process.env.OPENROUTER_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim();
    const baseURL =
      process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1';
    this.aiModel = process.env.AI_MODEL?.trim() || 'openai/gpt-4o-mini';

    if (apiKey) {
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
    } else {
      this.openai = null;
      this.logger.warn(
        'OpenRouter API key not found. World-wide ranking will be disabled.',
      );
    }

    // YandexGPT configuration (Priority for CIS)
    this.yandexApiKey = process.env.YANDEX_GPT_API_KEY?.trim() || null;
    this.yandexFolderId = process.env.YANDEX_FOLDER_ID?.trim() || null;

    if (this.yandexApiKey && this.yandexFolderId) {
      this.logger.log(
        'YandexGPT initialized as priority provider for CIS region.',
      );
    } else {
      this.logger.warn(
        'YandexGPT credentials not found. Falling back to OpenRouter for all regions.',
      );
    }
  }

  get client(): OpenAI {
    if (!this.openai) {
      throw new ServiceUnavailableException(
        'OpenRouter client is not configured.',
      );
    }
    return this.openai;
  }

  get model(): string {
    return this.aiModel || 'openai/gpt-4o-mini';
  }

  get yandexConfig() {
    if (!this.yandexApiKey || !this.yandexFolderId) return null;
    return { apiKey: this.yandexApiKey, folderId: this.yandexFolderId };
  }

  async chat(
    messages: ChatCompletionMessageParam[],
    options: {
      jsonMode?: boolean;
      temperature?: number;
      maxTokens?: number;
      isCis?: boolean;
      provider?: 'openrouter' | 'yandex';
    } = {},
  ): Promise<string> {
    if (options.provider === 'yandex') {
      return await this.chatWithYandex(messages, options);
    }
    if (options.provider === 'openrouter') {
      return await this.chatWithOpenRouter(messages, options);
    }

    if (options.isCis && this.yandexConfig) {
      try {
        return await this.chatWithYandex(messages, options);
      } catch (e: any) {
        this.logger.warn(
          `YandexGPT failed: ${e.message}. Falling back to OpenRouter...`,
        );
        return await this.chatWithOpenRouter(messages, options);
      }
    }

    try {
      return await this.chatWithOpenRouter(messages, options);
    } catch (e: any) {
      if (this.yandexConfig && !options.isCis) {
        this.logger.warn(
          `OpenRouter failed: ${e.message}. Attempting YandexGPT fallback...`,
        );
        return await this.chatWithYandex(messages, options);
      }
      throw e;
    }
  }

  private async chatWithOpenRouter(
    messages: ChatCompletionMessageParam[],
    options: { jsonMode?: boolean; temperature?: number; maxTokens?: number },
  ): Promise<string> {
    if (!this.openai) throw new Error('OpenRouter not configured');

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages,
      response_format: options.jsonMode ? { type: 'json_object' } : undefined,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    });

    const content = response.choices[0]?.message?.content ?? '';
    if (options.jsonMode) {
      return this.extractJson(content);
    }
    return content;
  }

  private async chatWithYandex(
    messages: ChatCompletionMessageParam[],
    options: { jsonMode?: boolean; temperature?: number; maxTokens?: number },
  ): Promise<string> {
    const config = this.yandexConfig;
    if (!config) throw new Error('YandexGPT not configured');

    const yandexMessages = messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user', // Yandex simplified roles
      text: String(m.content),
    }));

    const response = await fetch(
      'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
      {
        method: 'POST',
        headers: {
          Authorization: `Api-Key ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          modelUri: `gpt://${config.folderId}/yandexgpt-lite`,
          completionOptions: {
            stream: false,
            temperature: options.temperature ?? 0.3,
            maxTokens: options.maxTokens ?? 2000,
          },
          messages: yandexMessages,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`YandexGPT HTTP ${response.status}: ${errorText}`);
    }

    const payload = (await response.json()) as any;
    const text = payload.result?.alternatives?.[0]?.message?.text ?? '';

    if (options.jsonMode) {
      return this.extractJson(text);
    }

    return text;
  }

  private extractJson(text: string): string {
    // 1. Remove markdown code blocks if present
    let cleaned = text.replace(/```json\n?|```\n?/g, '').trim();

    // 2. Find the first '{' or '[' and the last '}' or ']'
    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    const lastBrace = cleaned.lastIndexOf('}');
    const lastBracket = cleaned.lastIndexOf(']');

    let start = -1;
    let end = -1;

    // Determine if it's an object or an array based on which comes first/last
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      start = firstBrace;
      end = lastBrace;
    } else if (firstBracket !== -1) {
      start = firstBracket;
      end = lastBracket;
    }

    if (start !== -1 && end !== -1 && end > start) {
      cleaned = cleaned.substring(start, end + 1);
    }

    // 3. Final attempt to fix trailing commas which break JSON.parse in some environments
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

    return cleaned;
  }

  isCisRegion(countryCode: string | null | undefined, city: string): boolean {
    const cisCountries = [
      'RU',
      'BY',
      'KZ',
      'AM',
      'GE',
      'AZ',
      'UZ',
      'KG',
      'TJ',
      'MD',
      'UA',
      'TM',
    ];
    if (countryCode && cisCountries.includes(countryCode.toUpperCase()))
      return true;
    if (/[а-яА-ЯёЁ]/.test(city)) return true;
    return false;
  }
}
