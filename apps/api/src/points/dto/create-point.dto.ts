import { IsString, IsNumber, IsOptional, IsInt, Min } from 'class-validator'
import { Type } from 'class-transformer'

export class CreatePointDto {
  @IsString()
  title: string

  @IsNumber()
  @Type(() => Number)
  lat: number

  @IsNumber()
  @Type(() => Number)
  lon: number

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
  @IsInt()
  @Min(0)
  @Type(() => Number)
  order?: number
}
