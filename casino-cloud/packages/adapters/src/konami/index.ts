import type { GatewayMachineConfig } from '@m1/shared';
import { NotImplementedAdapter } from '../base';

/**
 * Konami integration (Phase 5). Implement transport + translation by extending
 * ProtocolAdapter and mapping native messages onto the internal event model.
 */
export class KonamiAdapter extends NotImplementedAdapter {
  constructor(machine: GatewayMachineConfig) {
    super('konami', machine);
  }
}
