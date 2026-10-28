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

    const normalizeUuid = (uuid: string) => uuid.toLowerCase().replace(/[^a-f0-9]/g, '');
    const UART_SERVICE_UUID = '6e400001b5a3f393e0a9e50e24dcca9e';
    const UART_RX_UUID = '6e400002b5a3f393e0a9e50e24dcca9e';
    const UART_TX_UUID = '6e400003b5a3f393e0a9e50e24dcca9e';
    const uartService = services.find(service => normalizeUuid(service.uuid) === UART_SERVICE_UUID);
    if (!uartService) {
      const discovered = services.map(service => service.uuid).join(', ') || '(none)';
      throw new Error(`Nordic UART service not found. Expected=${UART_SERVICE_UUID}; discovered services=${discovered}. Check the Pico Arduino-Pico BLE UUID fix is installed.`);
    }

    console.log(`[BLE] Discovering UART characteristics: ${picoId}, service=${uartService.uuid}`);
    const characteristics = await withTimeout(
      peripheral,
      uartService.discoverCharacteristicsAsync([]),
      DISCOVERY_TIMEOUT_MS,
      `characteristic discovery timeout after ${DISCOVERY_TIMEOUT_MS}ms (service=${uartService.uuid})`
    );
    assertPeripheralConnected(peripheral, picoId);
    console.log(`[BLE] UART characteristics discovered: ${picoId}, count=${characteristics.length}`);
    for (const characteristic of characteristics) {
      console.log(`[BLE] Characteristic: Pico=${picoId} uuid=${characteristic.uuid} properties=${characteristic.properties.join(',')}`);
    }

    const writableCharacteristic = characteristics.find(characteristic =>
      normalizeUuid(characteristic.uuid) === UART_RX_UUID &&
      (characteristic.properties.includes('write') || characteristic.properties.includes('writeWithoutResponse'))
    );
    const notificationCharacteristic = characteristics.find(characteristic =>
      normalizeUuid(characteristic.uuid) === UART_TX_UUID &&
      (characteristic.properties.includes('notify') || characteristic.properties.includes('indicate'))
    );
    if (!writableCharacteristic) {
      throw new Error(`Nordic UART RX characteristic not writable. Expected=${UART_RX_UUID}; discovered=${characteristics.map(characteristic => `${characteristic.uuid}[${characteristic.properties.join(',')}]`).join('; ')}`);
    }
    if (!notificationCharacteristic) {
      throw new Error(`Nordic UART TX notification characteristic not found. Expected=${UART_TX_UUID}; discovered=${characteristics.map(characteristic => `${characteristic.uuid}[${characteristic.properties.join(',')}]`).join('; ')}`);
    }
    const writeWithoutResponse = !writableCharacteristic.properties.includes('write') &&
      writableCharacteristic.properties.includes('writeWithoutResponse');
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

    assertPeripheralConnected(peripheral, picoId);
    console.log(`[BLE] Subscribing to Nordic UART TX: Pico=${picoId} characteristic=${notificationCharacteristic.uuid}`);
    attachNotificationHandler(pico, notificationCharacteristic, () => {
      console.log(`[BLE] Heartbeat PING received: Pico=${picoId}`);
      missedHeartbeats = 0;
      consecutiveValidHeartbeats += 1;
      if (consecutiveValidHeartbeats >= 6) {
        // Only reset backoff after about 60 seconds of healthy heartbeat traffic.
        runtime.reconnectAttempts.delete(picoId);
        consecutiveValidHeartbeats = 0;
      }
      armHeartbeatWatchdog();
      void writableCharacteristic.writeAsync(Buffer.from('PONG\n', 'utf-8'), writeWithoutResponse).then(() => {
        console.log(`[BLE] Heartbeat PONG written: Pico=${picoId} characteristic=${writableCharacteristic.uuid}`);
      }).catch(error => {
        console.error(`[BLE] Heartbeat response failed: Pico=${picoId} characteristic=${writableCharacteristic.uuid}:`, error instanceof Error ? error.message : error);
      });
    });
    await withTimeout(
      peripheral,
      notificationCharacteristic.subscribeAsync(),
      DISCOVERY_TIMEOUT_MS,
      `notification subscription timeout after ${DISCOVERY_TIMEOUT_MS}ms (characteristic=${notificationCharacteristic.uuid})`
    );
    assertPeripheralConnected(peripheral, picoId);
    hasSubscription = true;
    // Wait for the Pico's first PING before starting the heartbeat timeout.
    // The Pico sends its first heartbeat 10 seconds after connection.
    console.log(`[BLE] Subscribed to Nordic UART TX: Pico=${picoId} characteristic=${notificationCharacteristic.uuid}`);

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
