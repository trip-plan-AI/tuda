import { IsArray, IsUUID } from 'class-validator'

export class ReorderPointsDto {
  @IsArray()
  @IsUUID('4', { each: true })
  ids: string[]
}
