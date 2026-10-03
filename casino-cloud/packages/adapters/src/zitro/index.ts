import type { GatewayMachineConfig } from '@m1/shared';
import { NotImplementedAdapter } from '../base';

/**
 * Zitro integration (Phase 5). Implement transport + translation by extending
 * ProtocolAdapter and mapping native messages onto the internal event model.
 */
export class ZitroAdapter extends NotImplementedAdapter {
  constructor(machine: GatewayMachineConfig) {
    super('zitro', machine);
  }
}
