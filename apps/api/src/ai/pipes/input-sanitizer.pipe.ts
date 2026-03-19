import { Injectable, PipeTransform, BadRequestException, Logger } from '@nestjs/common';
import { AiPlanRequestDto } from '../dto/ai-plan-request.dto';

const INJECTION_PATTERNS = [
  // Prompt injection variants
  'ignore previous',
  'forget about',
  'disregard',
  'override',
  'system:',
  'admin:',
  'root:',

  // Format markers
  '\\[INST\\]',
  '\\[/INST\\]',
  '###',
  '<\\|',
  '\\|>',

  // Common escape sequences
  '\\\\n---',
  'end of prompt',
  'end of instructions',

  // XML/HTML injection
  '<script',
  '</script>',
  'onload=',
  'onerror=',

  // SQL injection markers
  'select \\*',
  'insert into',
  'drop table',
  '; --',

  // Control characters that shouldn't be there
  '\\x00',
  '\\x01',
  '\\x02',
];

@Injectable()
export class InputSanitizerPipe implements PipeTransform {
  private readonly logger = new Logger('InputSanitizer');

  transform(value: AiPlanRequestDto): AiPlanRequestDto {
    let query = value.user_query ?? '';

    // 1. Length check
    if (query.length > 1000) {
      this.logger.warn(
        `Query exceeds max length: ${query.length} chars (truncating)`,
      );
      query = query.slice(0, 1000);
    }

    // 2. Check for injection patterns BEFORE sanitization for logging
    const detectedPatterns = INJECTION_PATTERNS.filter((pattern) => {
      try {
        return new RegExp(pattern, 'gi').test(query);
      } catch {
        return false;
      }
    });

    if (detectedPatterns.length > 0) {
      this.logger.warn(
        `Injection patterns detected and removed: ${detectedPatterns.join(', ')}`,
      );
    }

    // 3. Remove common injection markers
    query = query.replace(/[<>"'`]/g, '');

    // 4. Filter control characters (except tabs, newlines, carriage returns)
    query = query
      .split('')
      .filter((char) => {
        const code = char.charCodeAt(0);
        return (
          (code >= 32 && code !== 127) ||
          code === 9 ||
          code === 10 ||
          code === 13
        );
      })
      .join('');

    // 5. Remove injection patterns
    for (const pattern of INJECTION_PATTERNS) {
      try {
        query = query.replace(new RegExp(pattern, 'gi'), '');
      } catch {
        // Skip invalid regex patterns
      }
    }

    // 6. Final validation: if too many patterns detected, it might be an attack
    const finalDetectedCount = INJECTION_PATTERNS.filter((pattern) => {
      try {
        return new RegExp(pattern, 'gi').test(query);
      } catch {
        return false;
      }
    }).length;

    if (finalDetectedCount > 2) {
      this.logger.error(
        `Potential injection attack detected with ${finalDetectedCount} suspicious patterns after sanitization`,
      );
      throw new BadRequestException(
        'Request contains suspicious patterns and was rejected.',
      );
    }

    const sanitized = query.trim();

    if (sanitized.length === 0) {
      throw new BadRequestException('Query cannot be empty after sanitization.');
    }

    return { ...value, user_query: sanitized };
  }
}
