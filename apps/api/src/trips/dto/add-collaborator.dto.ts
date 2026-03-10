import { IsUUID, IsOptional, IsEnum } from 'class-validator';

export class AddCollaboratorDto {
  @IsUUID()
  userId: string;

  @IsOptional()
  @IsEnum(['editor', 'viewer'])
  role?: 'editor' | 'viewer' = 'editor';
}
