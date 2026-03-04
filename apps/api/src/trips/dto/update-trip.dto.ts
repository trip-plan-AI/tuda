import { IsString, IsOptional, IsInt, IsBoolean, Min } from 'class-validator'
import { Type } from 'class-transformer'

export class UpdateTripDto {
  @IsOptional()
  @IsString()
  title?: string

  @IsOptional()
  @IsString()
  description?: string

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  budget?: number

  @IsOptional()
  @IsString()
  startDate?: string

  @IsOptional()
  @IsString()
  endDate?: string

  @IsOptional()
  @IsBoolean()
  isActive?: boolean
}
