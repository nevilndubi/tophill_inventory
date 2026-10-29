import { Injectable } from '@nestjs/common';
import type { MachineConditionTransitionEvent } from '@app/shared';

export type ConditionTransitionListener = (
  event: MachineConditionTransitionEvent,
) => void | Promise<void>;

@Injectable()
export class ConditionEventsService {
  private readonly listeners = new Set<ConditionTransitionListener>();

  onTransition(listener: ConditionTransitionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit(event: MachineConditionTransitionEvent): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}
