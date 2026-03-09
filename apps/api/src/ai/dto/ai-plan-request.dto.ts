import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class AiPlanRequestDto {
  @IsString()
  @MaxLength(5000)
  user_query: string;

  @IsOptional()
  @IsUUID()
  trip_id?: string;
}
