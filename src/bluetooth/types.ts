export type PeripheralState = 'error' | 'connecting' | 'connected' | 'disconnecting' | 'disconnected';

export interface Characteristic {
  readonly uuid: string;
  readonly properties: readonly string[];
  subscribeAsync(): Promise<void>;
  readAsync(): Promise<Buffer>;
  on(event: 'data', listener: (data: Buffer) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface BleService {
  readonly uuid: string;
  discoverCharacteristicsAsync(characteristicUUIDs: string[]): Promise<Characteristic[]>;
}

export interface Peripheral {
  readonly id: string;
  readonly address: string;
  readonly state: PeripheralState;
  readonly advertisement: {
    readonly localName?: string | null;
  };
  connectAsync(): Promise<void>;
  disconnectAsync(): Promise<void>;
  discoverServicesAsync(serviceUUIDs: string[]): Promise<BleService[]>;
  once(event: 'disconnect', listener: (error?: Error | string) => void): this;
}

export type QueuedDevice = {
  peripheral: Peripheral;
  picoId: string;
  localName?: string;
};

export type KnownPico = {
  // Undefined until a fresh advertisement supplies a usable Peripheral object.
  peripheral?: Peripheral;
  localName?: string;
  lastSeenAt: number;
};

export type BleRuntime = {
  connectedPeripherals: Map<string, Peripheral>;
  connectingPeripherals: Set<string>;
  queuedPicos: Set<string>;
  pollingTimers: Map<string, ReturnType<typeof setInterval>>;
  reconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
  reconnectAttempts: Map<string, number>;
  knownPicos: Map<string, KnownPico>;
  connectionQueue: QueuedDevice[];
  getScanning: () => boolean;
  setScanning: (value: boolean) => void;
  getQueueRunning: () => boolean;
  setQueueRunning: (value: boolean) => void;
  isAdapterPoweredOn: () => boolean;
};

// Support both current and legacy Pico firmware BLE names.
export const PICO_NAME_KEYWORDS = ['leaf-pico', 'smartfarm-pico'] as const;
export const CONNECT_TIMEOUT_MS = 12_000;
export const CONNECT_RETRY_COUNT = 2;
export const CONNECT_RETRY_DELAY_MS = 1_000;
export const DISCOVERY_TIMEOUT_MS = 10_000;
// Start with a short cooldown, then back off while a Pico remains unavailable.
export const RECONNECT_DELAY_MS = 5_000;
export const MAX_RECONNECT_DELAY_MS = 30_000;
export const CONNECTION_SWEEP_INTERVAL_MS = 5_000;
export const SCAN_RECOVERY_INTERVAL_MS = 10_000;
export const SCAN_WATCHDOG_INTERVAL_MS = 60_000;
export const BLE_RESCAN_INTERVAL_MS = 10 * 60 * 1000;
export const KNOWN_PICO_STALE_MS = 60_000;
export const MAX_PENDING_TEXT = 4096;

export function normalizePicoId(rawId: string): string {
  return rawId.toLowerCase().replace(/[^a-z0-9]/g, '');
}
