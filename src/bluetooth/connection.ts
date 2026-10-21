import { Pico, picoList } from '../pico.js';
import {
  CONNECT_RETRY_COUNT, CONNECT_RETRY_DELAY_MS, CONNECT_TIMEOUT_MS,
  MAX_RECONNECT_DELAY_MS, Peripheral, QueuedDevice, RECONNECT_DELAY_MS, BleRuntime
} from './types.js';
import { setupPeripheral } from './gatt.js';
import { stopScanning, startScanning, restartScanning } from './scanner.js';

export function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function clearPicoPolling(runtime: BleRuntime, picoId: string) {
  const timer = runtime.pollingTimers.get(picoId);
  if (timer) { clearInterval(timer); runtime.pollingTimers.delete(picoId); }
  const heartbeatTimer = runtime.heartbeatTimers.get(picoId);
  if (heartbeatTimer) { clearTimeout(heartbeatTimer); runtime.heartbeatTimers.delete(picoId); }
}

export function clearReconnectTimer(runtime: BleRuntime, picoId: string) {
  const timer = runtime.reconnectTimers.get(picoId);
  if (timer) { clearTimeout(timer); runtime.reconnectTimers.delete(picoId); }
}

function invalidatePeripheral(runtime: BleRuntime, picoId: string, localName?: string) {
  const known = runtime.knownPicos.get(picoId);
  // Keep identity/name so name-less advertisements can still be recognized, but
  // discard the old Peripheral and force the next attempt to use a fresh scan result.
  runtime.knownPicos.set(picoId, {
    localName: localName || known?.localName,
    lastSeenAt: 0
  });
}

function removeQueuedPico(runtime: BleRuntime, picoId: string) {
  for (let index = runtime.connectionQueue.length - 1; index >= 0; index--) {
    if (runtime.connectionQueue[index]?.picoId === picoId) runtime.connectionQueue.splice(index, 1);
  }
  runtime.queuedPicos.delete(picoId);
}

export function enqueuePico(runtime: BleRuntime, peripheral: Peripheral, picoId: string, localName?: string) {
  if (!runtime.isAdapterPoweredOn()) return;
  if (runtime.connectedPeripherals.has(picoId) || runtime.connectingPeripherals.has(picoId) ||
      runtime.queuedPicos.has(picoId) || runtime.reconnectTimers.has(picoId)) return;

  runtime.queuedPicos.add(picoId);
  runtime.connectingPeripherals.add(picoId);
  runtime.connectionQueue.push({ peripheral, picoId, localName });
  console.log(`[BLE] Pico queued: ${picoId}`);
  void processConnectionQueue(runtime);
}

export function sweepKnownPicos(runtime: BleRuntime) {
  if (!runtime.isAdapterPoweredOn() || runtime.getQueueRunning()) return;
  for (const [picoId, device] of runtime.knownPicos) {
    // Never reconnect using an old or invalidated Peripheral object.
    if (!device.peripheral || Date.now() - device.lastSeenAt > 60_000) continue;
    if (!runtime.connectedPeripherals.has(picoId) && !runtime.connectingPeripherals.has(picoId) && !runtime.queuedPicos.has(picoId)) {
      enqueuePico(runtime, device.peripheral, picoId, device.localName);
    }
  }
}

export function scheduleReconnect(runtime: BleRuntime, picoId: string) {
  if (!runtime.isAdapterPoweredOn() || runtime.reconnectTimers.has(picoId)) return;

  const attempt = (runtime.reconnectAttempts.get(picoId) ?? 0) + 1;
  runtime.reconnectAttempts.set(picoId, attempt);
  const delayMs = Math.min(RECONNECT_DELAY_MS * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);

  runtime.reconnectTimers.set(picoId, setTimeout(() => {
    runtime.reconnectTimers.delete(picoId);
    if (!runtime.isAdapterPoweredOn()) return;

    console.log(`[BLE] Starting fresh scan for ${picoId} (retry ${attempt}, delay ${delayMs}ms)`);
    // Drop even advertisements received during cooldown so this cycle can only
    // enqueue a Peripheral discovered by the fresh scan.
    invalidatePeripheral(runtime, picoId);
    void restartScanning(runtime);
  }, delayMs));
}

async function connectWithRetry(peripheral: Peripheral, picoId: string) {
  for (let attempt = 1; attempt <= CONNECT_RETRY_COUNT; attempt++) {
    console.log(`[BLE] Connecting: ${picoId} (attempt ${attempt}/${CONNECT_RETRY_COUNT})`);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        peripheral.connectAsync(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`connection timeout after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS);
        })
      ]);
      console.log(`[BLE] Connected: ${picoId}`);
      return;
    } catch (error) {
      console.error(`[BLE] Connection attempt failed: ${picoId}`, error instanceof Error ? error.message : error);
      try { await peripheral.disconnectAsync(); } catch (_) {}
      if (attempt < CONNECT_RETRY_COUNT) await delay(CONNECT_RETRY_DELAY_MS);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  throw new Error(`failed to connect after ${CONNECT_RETRY_COUNT} attempts`);
}

export async function processConnectionQueue(runtime: BleRuntime) {
  if (runtime.getQueueRunning()) return;
  runtime.setQueueRunning(true);
  try {
    await stopScanning(runtime);
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
        runtime.reconnectAttempts.delete(item.picoId);
        runtime.knownPicos.set(item.picoId, {
          peripheral: item.peripheral,
          localName: item.localName || runtime.knownPicos.get(item.picoId)?.localName,
          lastSeenAt: Date.now()
        });

        const pico = getOrCreatePico(item.picoId, item.localName);
        pico.setConnected(true);
        registerDisconnectHandler(runtime, item.peripheral, item.picoId);
        await setupPeripheral(runtime, item.peripheral, item.picoId, item.localName);
        console.log(`[BLE] Connection ready: ${item.picoId}`);
      } catch (error) {
        runtime.connectedPeripherals.delete(item.picoId);
        runtime.connectingPeripherals.delete(item.picoId);
        removeQueuedPico(runtime, item.picoId);
        clearPicoPolling(runtime, item.picoId);
        const pico = picoList[item.picoId];
        if (pico) pico.setConnected(false);
        invalidatePeripheral(runtime, item.picoId, item.localName);
        console.error(`[BLE] Connection flow failed: ${item.picoId}:`, error instanceof Error ? error.message : error);

        // Clear state before disconnecting: the disconnect event may fire immediately.
        scheduleReconnect(runtime, item.picoId);
        try { await item.peripheral.disconnectAsync(); } catch (_) {}
      }
    }
  } finally {
    runtime.setQueueRunning(false);

    // A discover event can enqueue a device while the queue is finishing. Do not
    // leave that item stranded: drain it before allowing scanning to resume.
    if (runtime.isAdapterPoweredOn() && runtime.connectionQueue.length > 0) {
      void processConnectionQueue(runtime);
    } else if (runtime.isAdapterPoweredOn()) {
      await startScanning(runtime);
    }
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
    // A delayed event from an old Peripheral must not tear down a newer connection.
    if (runtime.connectedPeripherals.get(picoId) !== peripheral) return;

    const pico = picoList[picoId];
    if (pico) pico.setConnected(false);
    runtime.connectedPeripherals.delete(picoId);
    runtime.connectingPeripherals.delete(picoId);
    removeQueuedPico(runtime, picoId);
    clearPicoPolling(runtime, picoId);
    invalidatePeripheral(runtime, picoId);
    console.log(`[BLE] Disconnected: ${picoId}; cached connection discarded`);
    scheduleReconnect(runtime, picoId);
  });
}
