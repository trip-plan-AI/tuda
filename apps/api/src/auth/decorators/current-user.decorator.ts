import { createParamDecorator, ExecutionContext } from '@nestjs/common'

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): { id: string } =>
    ctx.switchToHttp().getRequest().user,
)
