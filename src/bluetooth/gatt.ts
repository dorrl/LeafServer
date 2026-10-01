import { BleRuntime, Characteristic, DISCOVERY_TIMEOUT_MS, Peripheral } from './types.js';
import { applyPicoState, attachNotificationHandler } from './parser.js';

export async function setupPeripheral(runtime: BleRuntime, peripheral: Peripheral, picoId: string, localName?: string) {
  const pico = (await import('../pico.js')).picoList[picoId];
  if (!pico) throw new Error(`Pico not found: ${picoId}`);

  try {
    console.log(`[BLE] Discovering services: ${picoId}`);
    const services = await Promise.race([
      peripheral.discoverServicesAsync([]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`service discovery timeout after ${DISCOVERY_TIMEOUT_MS}ms`)), DISCOVERY_TIMEOUT_MS))
    ]);
    console.log(`[BLE] Services discovered: ${picoId}, services=${services.length}`);

    const characteristics: Characteristic[] = [];
    const discoverableServices = services.filter((service: any) => {
      const uuid = String(service.uuid || '').toLowerCase().replace(/-/g, '');
      return uuid !== '1800' && uuid !== '1801';
    });

    for (const service of discoverableServices) {
      const serviceCharacteristics = await Promise.race([
        service.discoverCharacteristicsAsync([]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`characteristic discovery timeout after ${DISCOVERY_TIMEOUT_MS}ms`)), DISCOVERY_TIMEOUT_MS))
      ]);
      characteristics.push(...serviceCharacteristics);
    }

    console.log(`[BLE] Characteristics discovered: ${picoId}, services=${discoverableServices.length}, characteristics=${characteristics.length}`);

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
        if (!runtime.connectedPeripherals.has(picoId)) {
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
