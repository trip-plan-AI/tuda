import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllHttpExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.message
        : 'Internal server error';

    // Логируем только 5xx ошибки
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} - ${status}: ${message}`,
        exception instanceof Error ? exception.stack : '',
      );
    }

    // В development режиме показываем больше информации
    const isDev = process.env.NODE_ENV !== 'production';

    response.status(status).json({
      statusCode: status,
      message,
      ...(isDev && {
        error:
          exception instanceof HttpException
            ? exception.constructor.name
            : 'Internal Server Error',
        ...(exception instanceof Error && { stack: exception.stack }),
      }),
    });
  }
}
