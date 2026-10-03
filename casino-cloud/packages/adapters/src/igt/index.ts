import type { GatewayMachineConfig } from '@m1/shared';
import { NotImplementedAdapter } from '../base';

/**
 * IGT integration (Phase 5). Implement transport + translation by extending
 * ProtocolAdapter and mapping native messages onto the internal event model.
 */
export class IGTAdapter extends NotImplementedAdapter {
  constructor(machine: GatewayMachineConfig) {
    super('igt', machine);
  }
}
