import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ValidationException, ConflictError, NotFoundError } from './errors';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (exception instanceof ValidationException) {
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'ValidationError',
        message: exception.message,
        fields: exception.errors,
        path: request.url
      });
      return;
    }
    if (exception instanceof ConflictError) {
      response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: exception.message,
        field: exception.field,
        recordId: exception.recordId,
        path: request.url
      });
      return;
    }
    if (exception instanceof NotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        error: 'NotFound',
        message: exception.message,
        path: request.url
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json({
        statusCode: status,
        message: exception.message,
        path: request.url
      });
      return;
    }

    // Postgres unique violation: surface as a clean conflict.
    const pg = exception as { code?: string; constraint?: string; message?: string };
    if (pg?.code === '23505') {
      response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: pg.message ?? 'unique constraint violation',
        constraint: pg.constraint,
        path: request.url
      });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      path: request.url
    });
  }
}
