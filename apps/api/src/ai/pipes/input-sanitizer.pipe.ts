import { Injectable, PipeTransform } from '@nestjs/common';
import { AiPlanRequestDto } from '../dto/ai-plan-request.dto';

const INJECTION_PATTERNS = [
  'ignore previous',
  'system:',
  '\\[INST\\]',
  '###',
  '<\\|',
];

@Injectable()
export class InputSanitizerPipe implements PipeTransform {
  transform(value: AiPlanRequestDto): AiPlanRequestDto {
    let query = value.user_query ?? '';

    query = query.slice(0, 1000);
    query = query.replace(/[<>"'`]/g, '');
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

    for (const pattern of INJECTION_PATTERNS) {
      query = query.replace(new RegExp(pattern, 'gi'), '');
    }

    return { ...value, user_query: query.trim() };
  }
}
