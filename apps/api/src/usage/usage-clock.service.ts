import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

@Injectable()
export class UsageClockService {
  async now(transaction: Prisma.TransactionClient): Promise<Date> {
    const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
      SELECT CURRENT_TIMESTAMP AS "now"
    `;
    const now = rows[0]?.now;
    if (!(now instanceof Date)) throw new Error('Database clock did not return a timestamp');
    return now;
  }
}
