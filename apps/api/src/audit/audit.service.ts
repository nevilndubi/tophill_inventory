import { Injectable } from '@nestjs/common';
import type { AuditAction } from '@app/shared';
import type { Prisma } from '../generated/prisma/client';

export type AuditRecordInput = {
  action: AuditAction;
  actorUserId: string;
  after?: Prisma.InputJsonObject;
  before?: Prisma.InputJsonObject;
  context?: Prisma.InputJsonObject;
  entityId: string;
  entityType?: string;
  requestId: string;
};

@Injectable()
export class AuditService {
  async record(transaction: Prisma.TransactionClient, input: AuditRecordInput): Promise<void> {
    await transaction.auditLog.create({
      data: {
        action: input.action,
        actorUserId: input.actorUserId,
        after:
          input.context === undefined
            ? input.after
            : ({ ...(input.after ?? {}), context: input.context } satisfies Prisma.InputJsonObject),
        before: input.before,
        entityId: input.entityId,
        entityType: input.entityType ?? 'user',
        requestId: input.requestId,
      },
    });
  }
}
