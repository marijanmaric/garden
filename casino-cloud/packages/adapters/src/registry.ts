import type { GatewayMachineConfig } from '@m1/shared';
import type { AdapterFactory, GamingMachineAdapter } from './types';
import { SimulatorAdapter } from './simulator';
import { NovomaticAdapter } from './novomatic';
import { IGTAdapter } from './igt';
import { EGTAdapter } from './egt';
import { SYNOTAdapter } from './synot';
import { ZitroAdapter } from './zitro';
import { AristocratAdapter } from './aristocrat';
import { KonamiAdapter } from './konami';
import { SASAdapter } from './sas';

/** Adapter registry. Adding a manufacturer = implement the adapter + register one line here. */
const registry = new Map<string, AdapterFactory>([
  ['simulator', (m) => new SimulatorAdapter(m)],
  ['novomatic', (m) => new NovomaticAdapter(m)],
  ['igt', (m) => new IGTAdapter(m)],
  ['egt', (m) => new EGTAdapter(m)],
  ['synot', (m) => new SYNOTAdapter(m)],
  ['zitro', (m) => new ZitroAdapter(m)],
  ['aristocrat', (m) => new AristocratAdapter(m)],
  ['konami', (m) => new KonamiAdapter(m)],
  ['sas', (m) => new SASAdapter(m)],
]);

export function registerAdapter(key: string, factory: AdapterFactory) {
  registry.set(key, factory);
}

export function createAdapter(machine: GatewayMachineConfig): GamingMachineAdapter {
  const factory = registry.get(machine.adapter);
  if (!factory) throw new Error(`Unknown adapter "${machine.adapter}" for machine ${machine.machineId}`);
  return factory(machine);
}

export function listAdapters(): string[] {
  return [...registry.keys()];
}
