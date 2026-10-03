import { randomUUID } from 'node:crypto';
import {
  EMPTY_METERS,
  deriveMachineStatus,
  round2,
  type CommandResult,
  type GatewayMachineConfig,
  type MachineCommand,
  type MachineEvent,
  type MachineEventType,
  type MachineFlags,
  type MachineMeters,
  type MachineStatus,
  type PlayerSession,
} from '@m1/shared';
import type { GamingMachineAdapter } from '../types';

export interface SimulatorOptions {
  random?: () => number;
  now?: () => number;
  /** Player card ids the simulator may log in with. */
  playerCards?: string[];
}

interface Pending {
  at: number;
  type: MachineEventType;
  apply: () => void;
  data?: Partial<MachineEvent>;
}

const ERROR_CODES = ['BILL_JAM', 'REEL_TILT', 'COMM_TIMEOUT', 'HOPPER_EMPTY', 'RAM_ERROR'];
const BETS = [0.5, 1, 1, 2, 2, 3, 5];
const NOTES = [5, 10, 10, 20, 20, 50, 100];

/**
 * Simulates a gaming machine. Each tick() produces one realistic event; conditions
 * such as errors, open doors or offline periods recover automatically after a while.
 */
export class SimulatorAdapter implements GamingMachineAdapter {
  readonly key = 'simulator';
  private connected = false;
  private flags: MachineFlags = {
    online: true,
    disabled: false,
    maintenance: false,
    errorCode: null,
    doorOpen: false,
    cashboxOpen: false,
    printerError: false,
    jackpotPending: false,
  };
  private meters: MachineMeters = { ...EMPTY_METERS };
  private session: PlayerSession | null = null;
  private buffer: MachineEvent[] = [];
  private pending: Pending[] = [];
  private rnd: () => number;
  private now: () => number;
  private cards: string[];

  constructor(
    readonly machine: GatewayMachineConfig,
    opts: SimulatorOptions = {},
  ) {
    this.rnd = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.cards = opts.playerCards ?? Array.from({ length: 60 }, (_, i) => `PC-${String(i + 1).padStart(5, '0')}`);
  }

  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  async getStatus(): Promise<MachineStatus> {
    return deriveMachineStatus(this.flags);
  }
  async getMeters() {
    return { ...this.meters };
  }
  async getPlayerSession() {
    return this.session;
  }

  async getEvents(): Promise<MachineEvent[]> {
    this.processPending();
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  async sendCommand(command: MachineCommand): Promise<CommandResult> {
    if (!this.flags.online) return { commandId: command.id, success: false, message: 'Machine offline' };
    switch (command.type) {
      case 'LOCK':
        this.flags.disabled = true;
        this.emit('MACHINE_DISABLED', { message: 'Locked by operator' });
        break;
      case 'UNLOCK':
        this.flags.disabled = false;
        this.emit('MACHINE_ENABLED', { message: 'Unlocked by operator' });
        break;
      case 'RESET_ERROR':
        if (this.flags.errorCode) {
          this.flags.errorCode = null;
          this.emit('MACHINE_ERROR_CLEARED');
        }
        break;
      case 'RESET_JACKPOT':
        if (this.flags.jackpotPending) {
          this.flags.jackpotPending = false;
          this.emit('JACKPOT_RESET', { message: 'Handpay completed' });
        }
        break;
      case 'PING':
        break;
    }
    return { commandId: command.id, success: true };
  }

  /** Generate one random event. Called by the gateway's simulation driver. */
  tick(): void {
    if (!this.connected) return;
    this.processPending();
    const f = this.flags;
    if (!f.online || f.disabled || f.jackpotPending || f.errorCode) return;

    const r = this.rnd();
    if (r < 0.005) return this.goOffline();
    if (r < 0.011) return this.raiseError();
    if (r < 0.017) return this.temporary('MACHINE_DOOR_OPEN', 'MACHINE_DOOR_CLOSED', 'doorOpen', 5, 20);
    if (r < 0.021) return this.temporary('CASHBOX_OPEN', 'CASHBOX_CLOSED', 'cashboxOpen', 5, 25);
    if (r < 0.025) return this.temporary('PRINTER_ERROR', 'PRINTER_OK', 'printerError', 10, 40, { errorCode: 'PAPER_OUT' });
    if (r < 0.0255) return this.jackpot();
    if (r < 0.07) return this.togglePlayer();
    if (r < 0.17) return this.cashIn();
    if (r < 0.21) return this.ticketIn();
    if (r < 0.25) return this.ticketOut();
    if (r < 0.27) return this.coinOut();
    this.playGame();
  }

  // ---- event generators -------------------------------------------------

  private playGame() {
    const bet = this.pick(BETS);
    const r = this.rnd();
    let win = 0;
    // Base game return ~84%; jackpots add a few percent on top.
    if (r < 0.04) win = bet * (4 + this.rnd() * 12);
    else if (r < 0.26) win = bet * (1 + this.rnd() * 2);
    win = round2(win);
    this.meters.coinIn = round2(this.meters.coinIn + bet);
    this.meters.coinOut = round2(this.meters.coinOut + win);
    this.meters.gamesPlayed++;
    if (win > 0) this.meters.gamesWon++;
    this.emit('GAME_PLAYED', { amount: bet, win, playerCardId: this.session?.playerCardId });
  }

  private cashIn() {
    const amount = this.pick(NOTES);
    this.meters.cashIn += amount;
    this.emit('COIN_IN', { amount });
  }

  private coinOut() {
    const amount = round2(1 + this.rnd() * 20);
    this.meters.cashOut = round2(this.meters.cashOut + amount);
    this.emit('COIN_OUT', { amount });
  }

  private ticketIn() {
    const amount = round2(10 + this.rnd() * 190);
    this.meters.ticketsIn = round2(this.meters.ticketsIn + amount);
    this.emit('TICKET_IN', { amount, ticketBarcode: this.barcode() });
  }

  private ticketOut() {
    const amount = round2(10 + this.rnd() * 290);
    this.meters.ticketsOut = round2(this.meters.ticketsOut + amount);
    this.emit('TICKET_OUT', { amount, ticketBarcode: this.barcode() });
  }

  private jackpot() {
    const amount = round2(50 + this.rnd() * 550);
    this.meters.jackpot = round2(this.meters.jackpot + amount);
    this.flags.jackpotPending = true;
    this.emit('JACKPOT', { amount, playerCardId: this.session?.playerCardId });
    this.schedule(8, 25, 'JACKPOT_RESET', () => (this.flags.jackpotPending = false), { message: 'Handpay completed' });
  }

  private togglePlayer() {
    if (this.session) {
      const card = this.session.playerCardId;
      this.session = null;
      this.emit('PLAYER_LOGOUT', { playerCardId: card });
    } else {
      const card = this.pick(this.cards);
      this.session = { playerCardId: card, startedAt: new Date(this.now()).toISOString() };
      this.emit('PLAYER_LOGIN', { playerCardId: card });
    }
  }

  private raiseError() {
    const code = this.pick(ERROR_CODES);
    this.flags.errorCode = code;
    this.emit('MACHINE_ERROR', { errorCode: code, message: `Machine error ${code}` });
    this.schedule(10, 35, 'MACHINE_ERROR_CLEARED', () => (this.flags.errorCode = null));
  }

  private goOffline() {
    // Offline is observed by the gateway when communication drops; we report it on the machine's behalf.
    this.emit('MACHINE_OFFLINE', { message: 'Communication lost' });
    this.flags.online = false;
    if (this.session) this.session = null;
    this.schedule(15, 45, 'MACHINE_ONLINE', () => (this.flags.online = true), { message: 'Communication restored' });
  }

  private temporary(
    open: MachineEventType,
    close: MachineEventType,
    flag: 'doorOpen' | 'cashboxOpen' | 'printerError',
    minSec: number,
    maxSec: number,
    data: Partial<MachineEvent> = {},
  ) {
    this.flags[flag] = true;
    this.emit(open, data);
    this.schedule(minSec, maxSec, close, () => (this.flags[flag] = false));
  }

  // ---- helpers ----------------------------------------------------------

  private schedule(minSec: number, maxSec: number, type: MachineEventType, apply: () => void, data?: Partial<MachineEvent>) {
    const delay = (minSec + this.rnd() * (maxSec - minSec)) * 1000;
    this.pending.push({ at: this.now() + delay, type, apply, data });
  }

  private processPending() {
    const t = this.now();
    const due = this.pending.filter((p) => p.at <= t);
    if (!due.length) return;
    this.pending = this.pending.filter((p) => p.at > t);
    for (const p of due) {
      p.apply();
      this.emit(p.type, p.data);
    }
  }

  private emit(type: MachineEventType, data: Partial<MachineEvent> = {}) {
    this.buffer.push({
      eventId: randomUUID(),
      type,
      machineId: this.machine.machineId,
      timestamp: new Date(this.now()).toISOString(),
      source: this.key,
      ...data,
    });
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rnd() * arr.length)];
  }

  private barcode() {
    return Array.from({ length: 18 }, () => Math.floor(this.rnd() * 10)).join('');
  }
}
