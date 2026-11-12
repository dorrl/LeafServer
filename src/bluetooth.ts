import noble from '@abandonware/noble';
import { picoList } from './pico.js';
import { BleRuntime, BLE_STALL_TIMEOUT_MS, BLE_WATCHDOG_INTERVAL_MS, BLE_RESET_COOLDOWN_MS } from './bluetooth/types.js';
import { startScanning, setupScanner } from './bluetooth/scanner.js';

let scanning = false;
let queueRunning = false;
let adapterPoweredOn = false;
let queueProgressAt = 0;
let lastBleResetAt = 0;
let bleResetInProgress = false;

const runtime: BleRuntime = {
  connectedPeripherals: new Map(),
  connectingPeripherals: new Set(),
  queuedPicos: new Set(),
  pollingTimers: new Map(),
  heartbeatTimers: new Map(),
  reconnectTimers: new Map(),
  reconnectAttempts: new Map(),
  knownPicos: new Map(),
  connectionQueue: [],
  getScanning: () => scanning,
  setScanning: value => { scanning = value; },
  getQueueRunning: () => queueRunning,
  setQueueRunning: value => { queueRunning = value; },
  getQueueProgressAt: () => queueProgressAt,
  setQueueProgressAt: value => { queueProgressAt = value; },
  isAdapterPoweredOn: () => adapterPoweredOn
};

setupScanner(runtime);

// Recover only a genuinely stalled connection queue. A healthy idle scan with
// no nearby Pico is not a stall and must not cause periodic adapter resets.
setInterval(() => {
  if (!adapterPoweredOn || bleResetInProgress || !runtime.getQueueRunning()) return;

  const lastProgressAt = runtime.getQueueProgressAt();
  if (!lastProgressAt || Date.now() - lastProgressAt < BLE_STALL_TIMEOUT_MS) return;
  if (Date.now() - lastBleResetAt < BLE_RESET_COOLDOWN_MS) return;

  bleResetInProgress = true;
  lastBleResetAt = Date.now();
  console.error('[BLE] Connection processing stalled for 5 minutes; requesting Noble adapter reset');

  for (const timer of runtime.pollingTimers.values()) clearInterval(timer);
  for (const timer of runtime.heartbeatTimers.values()) clearTimeout(timer);
  for (const timer of runtime.reconnectTimers.values()) clearTimeout(timer);
  runtime.pollingTimers.clear();
  runtime.heartbeatTimers.clear();
  runtime.reconnectTimers.clear();
  runtime.reconnectAttempts.clear();

  for (const picoId of runtime.connectedPeripherals.keys()) {
    const pico = picoList[picoId];
    if (pico) pico.setConnected(false);
  }

  runtime.connectedPeripherals.clear();
  runtime.connectingPeripherals.clear();
  runtime.queuedPicos.clear();
  runtime.knownPicos.clear();
  runtime.connectionQueue.length = 0;
  runtime.setScanning(false);
  runtime.setQueueRunning(false);
  runtime.setQueueProgressAt(0);

  try {
    noble.reset();
    // Some adapters do not emit a full state cycle after reset. Give Noble a
    // bounded fallback to release the guard and request scanning if powered on.
    setTimeout(() => {
      bleResetInProgress = false;
      if (adapterPoweredOn) void startScanning(runtime);
    }, 30_000);
  } catch (error) {
    bleResetInProgress = false;
    console.error('[BLE] Noble adapter reset request failed:', error instanceof Error ? error.message : error);
  }
}, BLE_WATCHDOG_INTERVAL_MS);

noble.on('stateChange', async state => {
  adapterPoweredOn = state === 'poweredOn';
  if (adapterPoweredOn) {
    bleResetInProgress = false;
    await startScanning(runtime);
    return;
  }

  scanning = false;
  runtime.setQueueProgressAt(0);
  for (const timer of runtime.pollingTimers.values()) clearInterval(timer);
  for (const timer of runtime.heartbeatTimers.values()) clearTimeout(timer);
  runtime.heartbeatTimers.clear();
  runtime.pollingTimers.clear();
  for (const timer of runtime.reconnectTimers.values()) clearTimeout(timer);
  runtime.reconnectTimers.clear();
  runtime.reconnectAttempts.clear();

  for (const picoId of runtime.connectedPeripherals.keys()) {
    const pico = picoList[picoId];
    if (pico) pico.setConnected(false);
  }

  runtime.connectedPeripherals.clear();
  runtime.connectingPeripherals.clear();
  runtime.queuedPicos.clear();
  runtime.knownPicos.clear();
  runtime.connectionQueue.length = 0;
});

export { runtime };
