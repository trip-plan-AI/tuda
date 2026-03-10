import { Type } from 'class-transformer';
import { IsEnum, IsNumber, IsObject, IsOptional, ValidateNested } from 'class-validator';

export class OptimizationParamsDto {
  @IsNumber()
  @IsOptional()
  consumption?: number;

  @IsNumber()
  @IsOptional()
  fuelPrice?: number;

  @IsNumber()
  @IsOptional()
  tollFees?: number;

  @IsNumber()
  @IsOptional()
  transitFarePerKm?: number;
}

export class OptimizeTripDto {
  @IsEnum(['driving', 'foot', 'bike', 'direct'])
  @IsOptional()
  transportMode?: 'driving' | 'foot' | 'bike' | 'direct';

  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => OptimizationParamsDto)
  params?: OptimizationParamsDto;
}
