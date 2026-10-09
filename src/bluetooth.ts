import noble from '@abandonware/noble';
import { picoList } from './pico.js';
import { BleRuntime } from './bluetooth/types.js';
import { startScanning, setupScanner } from './bluetooth/scanner.js';

let scanning = false;
let queueRunning = false;
let adapterPoweredOn = false;

const runtime: BleRuntime = {
  connectedPeripherals: new Map(),
  connectingPeripherals: new Set(),
  queuedPicos: new Set(),
  pollingTimers: new Map(),
  reconnectTimers: new Map(),
  knownPicos: new Map(),
  connectionQueue: [],
  getScanning: () => scanning,
  setScanning: value => { scanning = value; },
  getQueueRunning: () => queueRunning,
  setQueueRunning: value => { queueRunning = value; },
  isAdapterPoweredOn: () => adapterPoweredOn
};

setupScanner(runtime);

noble.on('stateChange', async state => {
  adapterPoweredOn = state === 'poweredOn';
  if (adapterPoweredOn) {
    await startScanning(runtime);
    return;
  }

  scanning = false;
  for (const timer of runtime.pollingTimers.values()) clearInterval(timer);
  runtime.pollingTimers.clear();
  for (const timer of runtime.reconnectTimers.values()) clearTimeout(timer);
  runtime.reconnectTimers.clear();

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
