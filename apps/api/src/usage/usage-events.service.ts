import { Injectable } from '@nestjs/common';
import type { UsageSessionEvent } from '@app/shared';

export type UsageSessionListener = (event: UsageSessionEvent) => void | Promise<void>;

@Injectable()
export class UsageEventsService {
  private readonly listeners = new Set<UsageSessionListener>();

  onUsage(listener: UsageSessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit(event: UsageSessionEvent): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}
