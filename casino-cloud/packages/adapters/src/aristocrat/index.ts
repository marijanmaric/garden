import type { GatewayMachineConfig } from '@m1/shared';
import { NotImplementedAdapter } from '../base';

/**
 * Aristocrat integration (Phase 5). Implement transport + translation by extending
 * ProtocolAdapter and mapping native messages onto the internal event model.
 */
export class AristocratAdapter extends NotImplementedAdapter {
  constructor(machine: GatewayMachineConfig) {
    super('aristocrat', machine);
  }
}
