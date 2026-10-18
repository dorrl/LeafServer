import { BleRuntime, Characteristic, DISCOVERY_TIMEOUT_MS, Peripheral } from './types.js';
import { applyPicoState, attachNotificationHandler } from './parser.js';

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertPeripheralConnected(peripheral: Peripheral, picoId: string) {
  if (peripheral.state === 'disconnected') {
    throw new Error(`peripheral disconnected during GATT setup: ${picoId}`);
  }
}

export async function setupPeripheral(runtime: BleRuntime, peripheral: Peripheral, picoId: string, localName?: string) {
  const pico = (await import('../pico.js')).picoList[picoId];
  if (!pico) throw new Error(`Pico not found: ${picoId}`);

  try {
    console.log(`[BLE] Discovering services: ${picoId}`);
    const services = await withTimeout(
      peripheral.discoverServicesAsync([]),
      DISCOVERY_TIMEOUT_MS,
      `service discovery timeout after ${DISCOVERY_TIMEOUT_MS}ms`
    );
    assertPeripheralConnected(peripheral, picoId);
    console.log(`[BLE] Services discovered: ${picoId}, services=${services.length}`);
    if (services.length === 0) {
      throw new Error('service discovery returned 0 services');
    }

    const characteristics: Characteristic[] = [];
    const discoverableServices = services.filter((service: any) => {
      const uuid = String(service.uuid || '').toLowerCase().replace(/-/g, '');
      return uuid !== '1800' && uuid !== '1801';
    });

    for (const service of discoverableServices) {
      const serviceUuid = String(service.uuid || 'unknown');
      console.log(`[BLE] Discovering characteristics: ${picoId}, service=${serviceUuid}`);
      const serviceCharacteristics = await withTimeout(
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

    let hasSubscription = false;
    for (const characteristic of characteristics) {
      assertPeripheralConnected(peripheral, picoId);
      const properties: string[] = characteristic.properties || [];
      if (!properties.includes('notify') && !properties.includes('indicate')) continue;
      console.log(`[BLE] Subscribing: Pico=${picoId} characteristic=${characteristic.uuid}`);
      attachNotificationHandler(pico, characteristic);
      await withTimeout(
        characteristic.subscribeAsync(),
        DISCOVERY_TIMEOUT_MS,
        `notification subscription timeout after ${DISCOVERY_TIMEOUT_MS}ms (characteristic=${characteristic.uuid})`
      );
      assertPeripheralConnected(peripheral, picoId);
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
