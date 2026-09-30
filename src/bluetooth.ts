import noble from '@abandonware/noble';
import { Pico, picoList } from './pico.js';
import { PicoState } from './types.js';

type Peripheral = any;
type Characteristic = any;

type QueuedDevice = {
  peripheral: Peripheral;
  picoId: string;
  localName?: string;
};

const connectedPeripherals = new Map<string, Peripheral>();
const connectingPeripherals = new Set<string>();
const queuedPicos = new Set<string>();
const pollingTimers = new Map<string, ReturnType<typeof setInterval>>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const knownPicos = new Map<string, { peripheral: Peripheral; localName?: string; lastSeenAt: number }>();
const connectionQueue: QueuedDevice[] = [];

let scanning = false;
let queueRunning = false;
let adapterPoweredOn = false;

const PICO_NAME_KEYWORDS = ['smartfarm-pico'];
const CONNECT_TIMEOUT_MS = 12_000;
const CONNECT_RETRY_COUNT = 2;
const CONNECT_RETRY_DELAY_MS = 1_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 2_000;
const CONNECTION_SWEEP_INTERVAL_MS = 5_000;
const SCAN_RECOVERY_INTERVAL_MS = 10_000;
const KNOWN_PICO_STALE_MS = 60_000;
const MAX_PENDING_TEXT = 4096;

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startScanning() {
  if (!adapterPoweredOn || scanning || queueRunning) return;
  try {
    await noble.startScanningAsync([], true);
    scanning = true;
  } catch (error) {
    console.error('[BLE] Failed to start scan:', error instanceof Error ? error.message : error);
  }
}

async function stopScanning() {
  if (!scanning) return;
  try {
    await noble.stopScanningAsync();
  } catch (error) {
    console.error('[BLE] Failed to stop scan:', error instanceof Error ? error.message : error);
  } finally {
    scanning = false;
  }
}

function normalizePicoId(rawId: string) {
  return rawId.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getOrCreatePico(picoId: string, localName?: string) {
  let pico = picoList[picoId];
  if (!pico) {
    pico = new Pico({
      id: picoId,
      name: localName || `Pico-${picoId}`,
      connected: false,
      state: { temperature: 0, moisture: 0, light: 0 }
    });
    picoList[picoId] = pico;
  }
  // Keep the persisted/custom server-side name. The BLE advertised name is
  // only used when creating a Pico for the first time.
  return pico;
}

function clearPicoPolling(picoId: string) {
  const timer = pollingTimers.get(picoId);
  if (timer) {
    clearInterval(timer);
    pollingTimers.delete(picoId);
  }
}

function clearReconnectTimer(picoId: string) {
  const timer = reconnectTimers.get(picoId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(picoId);
  }
}

function enqueuePico(peripheral: Peripheral, picoId: string, localName?: string) {
  if (!adapterPoweredOn) return;
  if (connectedPeripherals.has(picoId) || connectingPeripherals.has(picoId) || queuedPicos.has(picoId)) return;

  queuedPicos.add(picoId);
  connectingPeripherals.add(picoId);
  connectionQueue.push({ peripheral, picoId, localName });
  console.log(`[BLE] Pico queued: ${picoId}`);
  void processConnectionQueue();
}

async function recoverScanning() {
  if (!adapterPoweredOn || scanning || queueRunning) return;
  await startScanning();
}

function sweepKnownPicos() {
  if (!adapterPoweredOn || queueRunning) return;
  const now = Date.now();

  for (const [picoId, device] of knownPicos) {
    if (now - device.lastSeenAt > KNOWN_PICO_STALE_MS) {
      knownPicos.delete(picoId);
      continue;
    }
    if (!connectedPeripherals.has(picoId) && !connectingPeripherals.has(picoId) && !queuedPicos.has(picoId)) {
      enqueuePico(device.peripheral, picoId, device.localName);
    }
  }
}

function scheduleReconnect(picoId: string) {
  if (!adapterPoweredOn || reconnectTimers.has(picoId)) return;
  reconnectTimers.set(picoId, setTimeout(() => {
    reconnectTimers.delete(picoId);
    void startScanning();
    sweepKnownPicos();
  }, RECONNECT_DELAY_MS));
}

async function connectWithRetry(peripheral: Peripheral, picoId: string) {
  for (let attempt = 1; attempt <= CONNECT_RETRY_COUNT; attempt++) {
    console.log(`[BLE] Connecting: ${picoId} (attempt ${attempt}/${CONNECT_RETRY_COUNT})`);
    try {
      await Promise.race([
        peripheral.connectAsync(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`connection timeout after ${CONNECT_TIMEOUT_MS}ms`)),
          CONNECT_TIMEOUT_MS
        ))
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

function parsePicoState(data: Buffer, currentState: PicoState): PicoState | null {
  const text = data.toString('utf-8').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    const result = { ...currentState };
    let changed = false;
    if (typeof parsed.temperature === 'number') { result.temperature = parsed.temperature; changed = true; }
    if (typeof parsed.moisture === 'number') { result.moisture = parsed.moisture; changed = true; }
    if (typeof parsed.light === 'number') { result.light = parsed.light; changed = true; }
    if (changed) return result;
  } catch (_) {}

  const result = { ...currentState };
  let found = false;
  const kvRegex = /(temp(?:erature)?|moist(?:ure)?|light|t|m|l)\s*[:=]\s*(-?\d+(?:\.\d+)?)/gi;
  let match: RegExpExecArray | null;
  while ((match = kvRegex.exec(text)) !== null) {
    const key = match[1].toLowerCase();
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (key.startsWith('t')) result.temperature = value;
    else if (key.startsWith('m')) result.moisture = value;
    else if (key.startsWith('l')) result.light = value;
    found = true;
  }
  if (found) return result;

  const parts = text.split(/[\s,]+/);
  if (parts.length === 3) {
    const temperature = Number(parts[0]);
    const moisture = Number(parts[1]);
    const light = Number(parts[2]);
    if ([temperature, moisture, light].every(Number.isFinite)) return { temperature, moisture, light };
  }

  if (data.length === 12) {
    return { temperature: data.readFloatLE(0), moisture: data.readFloatLE(4), light: data.readFloatLE(8) };
  }
  if (data.length === 6) {
    return { temperature: data.readInt16LE(0), moisture: data.readInt16LE(2), light: data.readInt16LE(4) };
  }
  return null;
}

function applyPicoState(pico: Pico, data: Buffer, characteristicUuid: string, source: 'notification' | 'polling') {
  const state = parsePicoState(data, pico.state);
  if (!state) return;
  try {
    pico.setState(state);
  } catch (error) {
    console.error(`[BLE] Invalid sensor payload from ${pico.id} (${source}, ${characteristicUuid}):`, error instanceof Error ? error.message : error);
  }
}

function attachNotificationHandler(pico: Pico, characteristic: Characteristic) {
  let pendingText = '';

  characteristic.on('data', (data: Buffer) => {
    // Pico sends newline-delimited UTF-8 JSON. BLE notifications may split a
    // single JSON message across multiple packets, so buffer until a newline.
    pendingText += data.toString('utf-8');

    if (pendingText.length > MAX_PENDING_TEXT) {
      const newline = pendingText.lastIndexOf('\\n');
      pendingText = newline >= 0 ? pendingText.slice(newline + 1) : pendingText.slice(-1024);
    }

    let newlineIndex = pendingText.indexOf('\\n');
    while (newlineIndex >= 0) {
      const line = pendingText.slice(0, newlineIndex).replace(/\\r$/, '').trim();
      pendingText = pendingText.slice(newlineIndex + 1);

      if (line) {
        applyPicoState(pico, Buffer.from(line, 'utf-8'), characteristic.uuid, 'notification');
      }

      newlineIndex = pendingText.indexOf('\\n');
    }
  });

  characteristic.on('error', (error: Error) => {
    console.error('[BLE] Notification error: Pico=' + pico.id + ' characteristic=' + characteristic.uuid + ':', error.message);
  });
}

async function setupPeripheral(peripheral: Peripheral, picoId: string, localName?: string) {
  const pico = getOrCreatePico(picoId, localName);
  try {
    console.log(`[BLE] Discovering services: ${picoId}`);

    // Split GATT discovery into service discovery and characteristic discovery.
    // This avoids relying on Noble's combined discovery operation when the
    // peripheral is slow to answer individual ATT requests.
    const services = await Promise.race([
      peripheral.discoverServicesAsync([]),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error(`service discovery timeout after ${DISCOVERY_TIMEOUT_MS}ms`)),
        DISCOVERY_TIMEOUT_MS
      ))
    ]);

    console.log(`[BLE] Services discovered: ${picoId}, services=${services.length}`);

    const characteristics: Characteristic[] = [];
    const discoverableServices = services.filter((service: any) => {
      const uuid = String(service.uuid || '').toLowerCase().replace(/-/g, '');
      // GAP/GATT services do not contain the Pico sensor UART characteristics.
      return uuid !== '1800' && uuid !== '1801';
    });

    for (const service of discoverableServices) {
      const serviceCharacteristics = await Promise.race([
        service.discoverCharacteristicsAsync([]),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`characteristic discovery timeout after ${DISCOVERY_TIMEOUT_MS}ms`)),
          DISCOVERY_TIMEOUT_MS
        ))
      ]);
      characteristics.push(...serviceCharacteristics);
    }

    console.log(
      `[BLE] Characteristics discovered: ${picoId}, services=${discoverableServices.length}, characteristics=${characteristics.length}`
    );

    let hasSubscription = false;
    for (const characteristic of characteristics) {
      const properties: string[] = characteristic.properties || [];
      if (!properties.includes('notify') && !properties.includes('indicate')) continue;
      console.log(`[BLE] Subscribing: Pico=${picoId} characteristic=${characteristic.uuid}`);
      attachNotificationHandler(pico, characteristic);
      await characteristic.subscribeAsync();
      hasSubscription = true;
      console.log(`[BLE] Subscribed: Pico=${picoId} characteristic=${characteristic.uuid}`);
    }

    const readableChars = characteristics.filter((characteristic: Characteristic) => {
      const properties: string[] = characteristic.properties || [];
      return properties.includes('read') && !properties.includes('notify') && !properties.includes('indicate');
    });

    if (readableChars.length > 0) {
      const lastValues = new Map<string, string>();
      let pollInProgress = false;
      const interval = setInterval(async () => {
        if (!connectedPeripherals.has(picoId)) {
          clearInterval(interval);
          pollingTimers.delete(picoId);
          return;
        }
        if (pollInProgress) return;
        pollInProgress = true;
        try {
          for (const characteristic of readableChars) {
            const data = await characteristic.readAsync();
            const value = data.toString('base64');
            if (lastValues.get(characteristic.uuid) === value) continue;
            lastValues.set(characteristic.uuid, value);
            applyPicoState(pico, data, characteristic.uuid, 'polling');
          }
        } catch (error) {
          console.error(`[BLE] Polling error: Pico=${picoId}:`, error instanceof Error ? error.message : error);
        } finally {
          pollInProgress = false;
        }
      }, hasSubscription ? 5000 : 1000);
      pollingTimers.set(picoId, interval);
    }

    if (!hasSubscription && readableChars.length === 0) {
      console.warn(`[BLE] Pico ${picoId} has no readable/notify characteristics`);
    }
  } catch (error) {
    console.error(`[BLE] Service setup failed: ${picoId}:`, error instanceof Error ? error.message : error);
    throw error;
  }
}

function registerDisconnectHandler(peripheral: Peripheral, picoId: string) {
  peripheral.once('disconnect', () => {
    const pico = picoList[picoId];
    if (pico) pico.setConnected(false);
    connectedPeripherals.delete(picoId);
    connectingPeripherals.delete(picoId);
    queuedPicos.delete(picoId);
    clearPicoPolling(picoId);
    console.log(`[BLE] Disconnected: ${picoId}`);
    scheduleReconnect(picoId);
  });
}

async function processConnectionQueue() {
  if (queueRunning) return;
  queueRunning = true;

  // Keep scanning disabled while connecting and discovering GATT services.
  // BlueZ/Noble should use the adapter exclusively for the connection flow.
  await stopScanning();

  try {
    while (connectionQueue.length > 0) {
      const item = connectionQueue.shift();
      if (!item) continue;
      queuedPicos.delete(item.picoId);
      if (!adapterPoweredOn || connectedPeripherals.has(item.picoId)) {
        connectingPeripherals.delete(item.picoId);
        continue;
      }

      try {
        await connectWithRetry(item.peripheral, item.picoId);
        connectedPeripherals.set(item.picoId, item.peripheral);
        connectingPeripherals.delete(item.picoId);
        clearReconnectTimer(item.picoId);

        const pico = getOrCreatePico(item.picoId, item.localName);
        pico.setConnected(true);
        registerDisconnectHandler(item.peripheral, item.picoId);
        await setupPeripheral(item.peripheral, item.picoId, item.localName);
        console.log('[BLE] Connection ready: ' + item.picoId);
      } catch (error) {
        connectedPeripherals.delete(item.picoId);
        connectingPeripherals.delete(item.picoId);
        clearPicoPolling(item.picoId);
        const pico = picoList[item.picoId];
        if (pico) pico.setConnected(false);
        console.error('[BLE] Connection flow failed: ' + item.picoId + ':', error instanceof Error ? error.message : error);
        try { await item.peripheral.disconnectAsync(); } catch (_) {}
      }
    }
  } finally {
    queueRunning = false;
    if (adapterPoweredOn) await startScanning();
  }
}

setInterval(() => {
  sweepKnownPicos();
}, CONNECTION_SWEEP_INTERVAL_MS);

setInterval(() => {
  void recoverScanning();
}, SCAN_RECOVERY_INTERVAL_MS);

noble.on('stateChange', async state => {
  adapterPoweredOn = state === 'poweredOn';
  if (adapterPoweredOn) {
    await startScanning();
    return;
  }

  scanning = false;
  for (const timer of pollingTimers.values()) clearInterval(timer);
  pollingTimers.clear();
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();
  for (const picoId of connectedPeripherals.keys()) {
    const pico = picoList[picoId];
    if (pico) pico.setConnected(false);
  }
  connectedPeripherals.clear();
  connectingPeripherals.clear();
  queuedPicos.clear();
  knownPicos.clear();
  connectionQueue.length = 0;
});

noble.on('discover', peripheral => {
  const localName = peripheral.advertisement.localName;
  const rawId = peripheral.address || peripheral.id;
  if (!rawId) return;

  const picoId = normalizePicoId(rawId);
  const isKnownPico = !!picoList[picoId];
  const isPico = isKnownPico || (!!localName && PICO_NAME_KEYWORDS.some(keyword => localName.toLowerCase().includes(keyword)));
  if (!isPico) return;

  const existing = knownPicos.get(picoId);
  knownPicos.set(picoId, {
    peripheral,
    localName: localName || existing?.localName || picoList[picoId]?.name,
    lastSeenAt: Date.now()
  });

  enqueuePico(peripheral, picoId, localName);
});
