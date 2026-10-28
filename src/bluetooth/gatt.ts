import { BleRuntime, BleService, Characteristic, DISCOVERY_TIMEOUT_MS, HEARTBEAT_TIMEOUT_MS, Peripheral } from './types.js';
import { applyPicoState, attachNotificationHandler } from './parser.js';

async function withTimeout<T>(
  peripheral: Peripheral,
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onDisconnect: ((error?: Error | string) => void) | undefined;
  const disconnected = new Promise<never>((_, reject) => {
    onDisconnect = error => {
      const detail = error ? `: ${String(error)}` : '';
      reject(new Error(`peripheral disconnected during GATT setup${detail}`));
    };
    peripheral.once('disconnect', onDisconnect);
  });

  try {
    return await Promise.race([
      operation,
      disconnected,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onDisconnect) peripheral.removeListener('disconnect', onDisconnect);
  }
}

function assertPeripheralConnected(peripheral: Peripheral, picoId: string): void {
  if (peripheral.state === 'disconnected') {
    throw new Error(`peripheral disconnected during GATT setup: ${picoId}`);
  }
}

export async function setupPeripheral(runtime: BleRuntime, peripheral: Peripheral, picoId: string, _localName?: string): Promise<void> {
  const pico = (await import('../pico.js')).picoList[picoId];
  if (!pico) throw new Error(`Pico not found: ${picoId}`);

  try {
    let services: BleService[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      assertPeripheralConnected(peripheral, picoId);
      console.log(`[BLE] Discovering services: ${picoId} (attempt ${attempt}/3)`);
      services = await withTimeout(
        peripheral,
        peripheral.discoverServicesAsync([]),
        DISCOVERY_TIMEOUT_MS,
        `service discovery timeout after ${DISCOVERY_TIMEOUT_MS}ms`
      );
      assertPeripheralConnected(peripheral, picoId);
      console.log(`[BLE] Services discovered: ${picoId}, services=${services.length}`);
      if (services.length > 0) break;
      if (attempt < 3) {
        console.warn(`[BLE] Empty service list for ${picoId}; retrying GATT discovery`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (services.length === 0) {
      throw new Error('service discovery returned 0 services after 3 attempts');
    }

    const discoverableServices = services.filter(service => {
      const uuid = service.uuid.toLowerCase().replace(/-/g, '');
      return uuid !== '1800' && uuid !== '1801';
    });
    const characteristics: Characteristic[] = [];

    for (const service of discoverableServices) {
      const serviceUuid = service.uuid || 'unknown';
      console.log(`[BLE] Discovering characteristics: ${picoId}, service=${serviceUuid}`);
      const serviceCharacteristics = await withTimeout(
        peripheral,
        service.discoverCharacteristicsAsync([]),
        DISCOVERY_TIMEOUT_MS,
        `characteristic discovery timeout after ${DISCOVERY_TIMEOUT_MS}ms (service=${serviceUuid})`
      );
      assertPeripheralConnected(peripheral, picoId);
      characteristics.push(...serviceCharacteristics);
      console.log(`[BLE] Characteristics discovered for service: ${picoId}, service=${serviceUuid}, count=${serviceCharacteristics.length}`);
    }

    console.log(`[BLE] Characteristics discovered: ${picoId}, services=${discoverableServices.length}, characteristics=${characteristics.length}`);
    if (characteristics.length === 0) {
      throw new Error('characteristic discovery returned 0 characteristics');
    }

    const writableCharacteristic = characteristics.find(characteristic =>
      characteristic.properties.includes('write') || characteristic.properties.includes('writeWithoutResponse')
    );
    const writeWithoutResponse = Boolean(writableCharacteristic &&
      !writableCharacteristic.properties.includes('write') &&
      writableCharacteristic.properties.includes('writeWithoutResponse'));
    let hasSubscription = false;
    let missedHeartbeats = 0;
    let consecutiveValidHeartbeats = 0;
    const armHeartbeatWatchdog = () => {
      const previousTimer = runtime.heartbeatTimers.get(picoId);
      if (previousTimer) clearTimeout(previousTimer);

      const timer = setTimeout(() => {
        runtime.heartbeatTimers.delete(picoId);
        if (runtime.connectedPeripherals.get(picoId) !== peripheral || peripheral.state === 'disconnected') return;

        missedHeartbeats += 1;
        if (missedHeartbeats >= 3) {
          console.warn(`[BLE] Heartbeat missed 3 consecutive intervals: ${picoId}; disconnecting stale connection`);
          void peripheral.disconnectAsync().catch(() => {});
          return;
        }

        console.warn(`[BLE] Heartbeat missed for ${picoId} (${missedHeartbeats}/3); keeping connection and waiting again`);
        armHeartbeatWatchdog();
      }, HEARTBEAT_TIMEOUT_MS);
      runtime.heartbeatTimers.set(picoId, timer);
    };

    for (const characteristic of characteristics) {
      assertPeripheralConnected(peripheral, picoId);
      const properties = characteristic.properties;
      if (!properties.includes('notify') && !properties.includes('indicate')) continue;
      console.log(`[BLE] Subscribing: Pico=${picoId} characteristic=${characteristic.uuid}`);
      if (!writableCharacteristic) {
        throw new Error('Pico UART write characteristic not found; heartbeat response is unavailable');
      }
      attachNotificationHandler(pico, characteristic, () => {
        missedHeartbeats = 0;
        consecutiveValidHeartbeats += 1;
        if (consecutiveValidHeartbeats >= 6) {
          // A connection is stable only after about 60 seconds of valid PINGs.
          // Short-lived links retain their exponential reconnect backoff.
          runtime.reconnectAttempts.delete(picoId);
          consecutiveValidHeartbeats = 0;
        }
        armHeartbeatWatchdog();
        void writableCharacteristic.writeAsync(Buffer.from('PONG\\n', 'utf-8'), writeWithoutResponse).catch(error => {
          console.error(`[BLE] Heartbeat response failed: ${picoId}:`, error instanceof Error ? error.message : error);
        });
      });
      await withTimeout(
        peripheral,
        characteristic.subscribeAsync(),
        DISCOVERY_TIMEOUT_MS,
        `notification subscription timeout after ${DISCOVERY_TIMEOUT_MS}ms (characteristic=${characteristic.uuid})`
      );
      assertPeripheralConnected(peripheral, picoId);
      hasSubscription = true;
      armHeartbeatWatchdog();
      console.log(`[BLE] Subscribed: Pico=${picoId} characteristic=${characteristic.uuid}`);
    }

    const readableChars = characteristics.filter(characteristic => {
      const properties = characteristic.properties;
      return properties.includes('read') && !properties.includes('notify') && !properties.includes('indicate');
    });

    if (readableChars.length > 0) {
      const lastValues = new Map<string, string>();
      let pollInProgress = false;
      const interval = setInterval(async () => {
        if (!runtime.connectedPeripherals.has(picoId) || peripheral.state === 'disconnected') {
          clearInterval(interval);
          runtime.pollingTimers.delete(picoId);
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
      runtime.pollingTimers.set(picoId, interval);
    }

    if (!hasSubscription && readableChars.length === 0) console.warn(`[BLE] Pico ${picoId} has no readable/notify characteristics`);
  } catch (error) {
    console.error(`[BLE] Service setup failed: ${picoId}:`, error instanceof Error ? error.message : error);
    throw error;
  }
}
