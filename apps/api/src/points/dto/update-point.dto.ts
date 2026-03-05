import { IsString, IsNumber, IsOptional, IsInt, Min } from 'class-validator'
import { Type } from 'class-transformer'

export class UpdatePointDto {
  @IsOptional()
  @IsString()
  title?: string

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  lat?: number

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  lon?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  budget?: number

  @IsOptional()
  @IsString()
  visitDate?: string

  @IsOptional()
  @IsString()
  imageUrl?: string

  @IsOptional()
  @IsString()
  address?: string

}
