import {
  IsString,
  IsOptional,
  IsEnum,
  IsObject,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class PointDto {
  @IsString()
  id: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  lat: number;

  @IsOptional()
  lon: number;

  @IsOptional()
  budget?: number;

  @IsOptional()
  transportMode?: 'driving' | 'foot' | 'bike' | 'direct';
}

export class OptimizeTripDto {
  @IsOptional()
  @IsEnum(['driving', 'foot', 'bike', 'direct'])
  transportMode?: 'driving' | 'foot' | 'bike' | 'direct';

  @IsOptional()
  @IsObject()
  params?: {
    consumption?: number;
    fuelPrice?: number;
    tollFees?: number;
    transitFarePerKm?: number;
  };

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PointDto)
  points?: PointDto[];
}
