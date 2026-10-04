import noble from '@abandonware/noble';
import {
  BleRuntime,
  PICO_NAME_KEYWORDS,
  KNOWN_PICO_STALE_MS,
  Peripheral,
  normalizePicoId,
  SCAN_RECOVERY_INTERVAL_MS,
  CONNECTION_SWEEP_INTERVAL_MS,
  BLE_RESCAN_INTERVAL_MS
} from './types.js';
import { enqueuePico, sweepKnownPicos } from './connection.js';

export async function startScanning(runtime: BleRuntime) {
  if (!runtime.isAdapterPoweredOn() || runtime.getScanning() || runtime.getQueueRunning()) return;
  try {
    await noble.startScanningAsync([], true);
    runtime.setScanning(true);
  } catch (error) {
    console.error('[BLE] Failed to start scan:', error instanceof Error ? error.message : error);
  }
}

export async function stopScanning(runtime: BleRuntime) {
  if (!runtime.getScanning()) return;
  try {
    await noble.stopScanningAsync();
  } catch (error) {
    console.error('[BLE] Failed to stop scan:', error instanceof Error ? error.message : error);
  } finally {
    runtime.setScanning(false);
  }
}

async function restartScanning(runtime: BleRuntime) {
  if (!runtime.isAdapterPoweredOn() || runtime.getQueueRunning()) return;
  await stopScanning(runtime);
  await startScanning(runtime);
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
    enqueuePico(runtime, peripheral, picoId, localName);
  });

  setInterval(() => sweepKnownPicos(runtime), CONNECTION_SWEEP_INTERVAL_MS);

  setInterval(() => {
    if (!runtime.isAdapterPoweredOn() || runtime.getScanning() || runtime.getQueueRunning()) return;
    void startScanning(runtime);
  }, SCAN_RECOVERY_INTERVAL_MS);

  setInterval(() => {
    void restartScanning(runtime);
  }, BLE_RESCAN_INTERVAL_MS);
}

export async function recoverScanning(runtime: BleRuntime) {
  if (!runtime.isAdapterPoweredOn() || runtime.getScanning() || runtime.getQueueRunning()) return;
  await startScanning(runtime);
}

export function removeStalePicos(runtime: BleRuntime) {
  const now = Date.now();
  for (const [picoId, device] of runtime.knownPicos) {
    if (now - device.lastSeenAt > KNOWN_PICO_STALE_MS) runtime.knownPicos.delete(picoId);
  }
}
