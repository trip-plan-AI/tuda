// TODO: Replace with real JWT guard in TRI-04 (passport-jwt strategy)
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common'

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest()
    // Stub: attach placeholder user until TRI-04 implements real JWT
    if (!request.user) {
      request.user = { id: 'stub-user-id' }
    }
    return true
  }
}
