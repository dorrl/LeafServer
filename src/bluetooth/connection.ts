import noble from '@abandonware/noble';
import { Pico, picoList } from '../pico.js';
import {
  CONNECT_RETRY_COUNT, CONNECT_RETRY_DELAY_MS, CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS, Peripheral, QueuedDevice, RECONNECT_DELAY_MS, BleRuntime
} from './types.js';
import { setupPeripheral } from './gatt.js';
import { stopScanning, startScanning } from './scanner.js';

export function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function clearPicoPolling(runtime: BleRuntime, picoId: string) {
  const timer = runtime.pollingTimers.get(picoId);
  if (timer) { clearInterval(timer); runtime.pollingTimers.delete(picoId); }
}

export function clearReconnectTimer(runtime: BleRuntime, picoId: string) {
  const timer = runtime.reconnectTimers.get(picoId);
  if (timer) { clearTimeout(timer); runtime.reconnectTimers.delete(picoId); }
}

export function enqueuePico(runtime: BleRuntime, peripheral: Peripheral, picoId: string, localName?: string) {
  if (!runtime.isAdapterPoweredOn()) return;
  if (runtime.connectedPeripherals.has(picoId) || runtime.connectingPeripherals.has(picoId) || runtime.queuedPicos.has(picoId)) return;
  runtime.queuedPicos.add(picoId);
  runtime.connectingPeripherals.add(picoId);
  runtime.connectionQueue.push({ peripheral, picoId, localName });
  console.log(`[BLE] Pico queued: ${picoId}`);
  void processConnectionQueue(runtime);
}

export function sweepKnownPicos(runtime: BleRuntime) {
  if (!runtime.isAdapterPoweredOn() || runtime.getQueueRunning()) return;
  const now = Date.now();
  for (const [picoId, device] of runtime.knownPicos) {
    if (now - device.lastSeenAt > 60_000) { runtime.knownPicos.delete(picoId); continue; }
    if (!runtime.connectedPeripherals.has(picoId) && !runtime.connectingPeripherals.has(picoId) && !runtime.queuedPicos.has(picoId)) {
      enqueuePico(runtime, device.peripheral, picoId, device.localName);
    }
  }
}

export function scheduleReconnect(runtime: BleRuntime, picoId: string) {
  if (!runtime.isAdapterPoweredOn() || runtime.reconnectTimers.has(picoId)) return;
  runtime.reconnectTimers.set(picoId, setTimeout(() => {
    runtime.reconnectTimers.delete(picoId);
    void startScanning(runtime);
    sweepKnownPicos(runtime);
  }, RECONNECT_DELAY_MS));
}

async function connectWithRetry(peripheral: Peripheral, picoId: string) {
  for (let attempt = 1; attempt <= CONNECT_RETRY_COUNT; attempt++) {
    console.log(`[BLE] Connecting: ${picoId} (attempt ${attempt}/${CONNECT_RETRY_COUNT})`);
    try {
      await Promise.race([
        peripheral.connectAsync(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`connection timeout after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS))
      ]);
      console.log(`[BLE] Connected: ${picoId}`);
      return;
    } catch (error) {
      console.error(`[BLE] Connection attempt failed: ${picoId}`, error instanceof Error ? error.message : error);
      try { await peripheral.disconnectAsync(); } catch (_) {}
      if (attempt < CONNECT_RETRY_COUNT) await delay(CONNECT_RETRY_DELAY_MS);
    }
  }
  throw new Error(`failed to connect after ${CONNECT_RETRY_COUNT} attempts`);
}

export async function processConnectionQueue(runtime: BleRuntime) {
  if (runtime.getQueueRunning()) return;
  runtime.setQueueRunning(true);
  await stopScanning(runtime);
  try {
    while (runtime.connectionQueue.length > 0) {
      const item: QueuedDevice | undefined = runtime.connectionQueue.shift();
      if (!item) continue;
      runtime.queuedPicos.delete(item.picoId);
      if (!runtime.isAdapterPoweredOn() || runtime.connectedPeripherals.has(item.picoId)) {
        runtime.connectingPeripherals.delete(item.picoId);
        continue;
      }
      try {
        await connectWithRetry(item.peripheral, item.picoId);
        runtime.connectedPeripherals.set(item.picoId, item.peripheral);
        runtime.connectingPeripherals.delete(item.picoId);
        clearReconnectTimer(runtime, item.picoId);
        const pico = getOrCreatePico(item.picoId, item.localName);
        pico.setConnected(true);
        registerDisconnectHandler(runtime, item.peripheral, item.picoId);
        await setupPeripheral(runtime, item.peripheral, item.picoId, item.localName);
        console.log(`[BLE] Connection ready: ${item.picoId}`);
      } catch (error) {
        runtime.connectedPeripherals.delete(item.picoId);
        runtime.connectingPeripherals.delete(item.picoId);
        clearPicoPolling(runtime, item.picoId);
        const pico = picoList[item.picoId];
        if (pico) pico.setConnected(false);
        console.error(`[BLE] Connection flow failed: ${item.picoId}:`, error instanceof Error ? error.message : error);
        try { await item.peripheral.disconnectAsync(); } catch (_) {}
      }
    }
  } finally {
    runtime.setQueueRunning(false);
    if (runtime.isAdapterPoweredOn()) await startScanning(runtime);
  }
}

function getOrCreatePico(picoId: string, localName?: string) {
  let pico = picoList[picoId];
  if (!pico) {
    pico = new Pico({ id: picoId, name: localName || `Pico-${picoId}`, connected: false, state: { temperature: 0, moisture: 0, light: 0 } });
    picoList[picoId] = pico;
  }
  return pico;
}

function registerDisconnectHandler(runtime: BleRuntime, peripheral: Peripheral, picoId: string) {
  peripheral.once('disconnect', () => {
    const pico = picoList[picoId];
    if (pico) pico.setConnected(false);
    runtime.connectedPeripherals.delete(picoId);
    runtime.connectingPeripherals.delete(picoId);
    runtime.queuedPicos.delete(picoId);
    clearPicoPolling(runtime, picoId);
    console.log(`[BLE] Disconnected: ${picoId}`);
    scheduleReconnect(runtime, picoId);
  });
}
