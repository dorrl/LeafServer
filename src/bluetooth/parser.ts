import { Pico, picoList } from '../pico.js';
import { PicoState } from '../types.js';
import { Characteristic, MAX_PENDING_TEXT } from './types.js';

export function parsePicoState(data: Buffer, currentState: PicoState): PicoState | null {
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

export function applyPicoState(pico: Pico, data: Buffer, characteristicUuid: string, source: 'notification' | 'polling') {
  const state = parsePicoState(data, pico.state);
  if (!state) return;
  try {
    pico.setState(state);
  } catch (error) {
    console.error(`[BLE] Invalid sensor payload from ${pico.id} (${source}, ${characteristicUuid}):`, error instanceof Error ? error.message : error);
  }
}

export function attachNotificationHandler(pico: Pico, characteristic: Characteristic) {
  let pendingText = '';

  characteristic.on('data', (data: Buffer) => {
    pendingText += data.toString('utf-8');

    if (pendingText.length > MAX_PENDING_TEXT) {
      const newline = pendingText.lastIndexOf('\n');
      pendingText = newline >= 0 ? pendingText.slice(newline + 1) : pendingText.slice(-1024);
    }

    let newlineIndex = pendingText.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = pendingText.slice(0, newlineIndex).replace(/\r$/, '').trim();
      pendingText = pendingText.slice(newlineIndex + 1);

      if (line) applyPicoState(pico, Buffer.from(line, 'utf-8'), characteristic.uuid, 'notification');
      newlineIndex = pendingText.indexOf('\n');
    }
  });

  characteristic.on('error', (error: Error) => {
    console.error(`[BLE] Notification error: Pico=${pico.id} characteristic=${characteristic.uuid}:`, error.message);
  });
}
