export type Peripheral = any;
export type Characteristic = any;

export type QueuedDevice = {
  peripheral: Peripheral;
  picoId: string;
  localName?: string;
};

export type KnownPico = {
  peripheral: Peripheral;
  localName?: string;
  lastSeenAt: number;
};

export type BleRuntime = {
  connectedPeripherals: Map<string, Peripheral>;
  connectingPeripherals: Set<string>;
  queuedPicos: Set<string>;
  pollingTimers: Map<string, ReturnType<typeof setInterval>>;
  reconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
  knownPicos: Map<string, KnownPico>;
  connectionQueue: QueuedDevice[];
  getScanning: () => boolean;
  setScanning: (value: boolean) => void;
  getQueueRunning: () => boolean;
  setQueueRunning: (value: boolean) => void;
  isAdapterPoweredOn: () => boolean;
};

export const PICO_NAME_KEYWORDS = ['smartfarm-pico'];
export const CONNECT_TIMEOUT_MS = 12_000;
export const CONNECT_RETRY_COUNT = 2;
export const CONNECT_RETRY_DELAY_MS = 1_000;
export const DISCOVERY_TIMEOUT_MS = 10_000;
export const RECONNECT_DELAY_MS = 5 * 60 * 1000;
export const CONNECTION_SWEEP_INTERVAL_MS = 5_000;
export const SCAN_RECOVERY_INTERVAL_MS = 10_000;
export const KNOWN_PICO_STALE_MS = 60_000;
export const MAX_PENDING_TEXT = 4096;

export function normalizePicoId(rawId: string) {
  return rawId.toLowerCase().replace(/[^a-z0-9]/g, '');
}
