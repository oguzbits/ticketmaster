import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Parses a route parameter with a Zod schema; the 400 names the failing paths, never the value. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<string, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: string): z.output<S> {
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
