import noble from '@abandonware/noble';
import {
  BleRuntime,
  PICO_NAME_KEYWORDS,
  KNOWN_PICO_STALE_MS,
  Peripheral,
  normalizePicoId,
  SCAN_RECOVERY_INTERVAL_MS,
  SCAN_WATCHDOG_INTERVAL_MS,
  CONNECTION_SWEEP_INTERVAL_MS,
  BLE_RESCAN_INTERVAL_MS
} from './types.js';
import { clearReconnectTimer, enqueuePico, sweepKnownPicos } from './connection.js';

// Serialize every Noble scan operation. Requests are queued rather than dropped,
// so a stop requested during start (or vice versa) is not silently lost.
let scanOperation: Promise<void> | undefined;

async function withScanLock(operation: () => Promise<void>) {
  const previous = scanOperation ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  scanOperation = current;
  try {
    await current;
  } finally {
    if (scanOperation === current) scanOperation = undefined;
  }
}

export async function startScanning(runtime: BleRuntime) {
  if (!runtime.isAdapterPoweredOn() || runtime.getQueueRunning()) return;

  await withScanLock(async () => {
    if (!runtime.isAdapterPoweredOn() || runtime.getQueueRunning() || runtime.getScanning()) return;
    try {
      await noble.startScanningAsync([], true);
      runtime.setScanning(true);
    } catch (error) {
      runtime.setScanning(false);
      console.error('[BLE] Failed to start scan:', error instanceof Error ? error.message : error);
    }
  });
}

export async function stopScanning(runtime: BleRuntime) {
  await withScanLock(async () => {
    // Stop Noble even if our local flag is false; that flag may be stale.
    try {
      await noble.stopScanningAsync();
    } catch (error) {
      // Noble can reject when it was already stopped. Keep recovery moving.
      const message = error instanceof Error ? error.message : String(error);
      if (!/not scanning|already stopped|does not exist/i.test(message)) {
        console.error('[BLE] Failed to stop scan:', message);
      }
    } finally {
      runtime.setScanning(false);
    }
  });
}

export async function restartScanning(runtime: BleRuntime) {
  if (!runtime.isAdapterPoweredOn() || runtime.getQueueRunning()) return;

  await withScanLock(async () => {
    if (!runtime.isAdapterPoweredOn() || runtime.getQueueRunning()) return;
    try {
      await noble.stopScanningAsync();
    } catch (_) {
      // Noble may report that scanning was already stopped.
    } finally {
      runtime.setScanning(false);
    }

    if (!runtime.isAdapterPoweredOn() || runtime.getQueueRunning()) return;
    try {
      await noble.startScanningAsync([], true);
      runtime.setScanning(true);
    } catch (error) {
      runtime.setScanning(false);
      console.error('[BLE] Failed to restart scan:', error instanceof Error ? error.message : error);
    }
  });
}

export function setupScanner(runtime: BleRuntime) {
  noble.on('discover', (peripheral: Peripheral) => {
    const localName = peripheral.advertisement.localName;
    const rawId = peripheral.address || peripheral.id;
    if (!rawId) return;

    const picoId = normalizePicoId(rawId);
    const isKnownPico = runtime.knownPicos.has(picoId);
    const isPico = isKnownPico || PICO_NAME_KEYWORDS.some(keyword => localName?.toLowerCase().includes(keyword));
    if (!isPico) return;

    const existing = runtime.knownPicos.get(picoId);
    runtime.knownPicos.set(picoId, {
      peripheral,
      localName: localName || existing?.localName,
      lastSeenAt: Date.now()
    });

    // A fresh advertisement supersedes a pending cooldown and provides a fresh
    // Peripheral object for the next connection attempt.
    clearReconnectTimer(runtime, picoId);
    enqueuePico(runtime, peripheral, picoId, localName || existing?.localName);
  });

  setInterval(() => sweepKnownPicos(runtime), CONNECTION_SWEEP_INTERVAL_MS);

  setInterval(() => {
    if (!runtime.isAdapterPoweredOn() || runtime.getScanning() || runtime.getQueueRunning()) return;
    void startScanning(runtime);
  }, SCAN_RECOVERY_INTERVAL_MS);

  setInterval(() => { void restartScanning(runtime); }, SCAN_WATCHDOG_INTERVAL_MS);
  setInterval(() => { void restartScanning(runtime); }, BLE_RESCAN_INTERVAL_MS);
}

export async function recoverScanning(runtime: BleRuntime) {
  if (!runtime.isAdapterPoweredOn() || runtime.getQueueRunning()) return;
  if (!runtime.getScanning()) await startScanning(runtime);
}

export function removeStalePicos(runtime: BleRuntime) {
  const now = Date.now();
  for (const [picoId, device] of runtime.knownPicos) {
    if (now - device.lastSeenAt > KNOWN_PICO_STALE_MS) runtime.knownPicos.delete(picoId);
  }
}
