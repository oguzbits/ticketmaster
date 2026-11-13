import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Parses a parameter, header or body with a Zod schema; the 400 names the failing paths, never the value. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<z.input<S>, z.output<S>> {
  /** Public so the OpenAPI spec can compare it with the route table. */
  constructor(readonly schema: S) {}

  transform(value: z.input<S>): z.output<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Invalid request',
        issues: result.error.issues.map((issue) => issue.path.join('.') || 'value'),
      });
    }
    return result.data;
  }
}
