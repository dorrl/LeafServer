import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Alert, OptimalRange, PicoState, PicoType, Reading, ServerSettings } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../data');
const dataFile = path.join(dataDir, 'smartfarm-state.json');
export const DEFAULT_SETTINGS: ServerSettings = { measurementIntervalMinutes: 1, syncIntervalMinutes: 5, retentionMonths: 6 };

type PersistedData = { picos: PicoType[]; readings: Reading[]; alerts: Alert[]; settings?: ServerSettings; };
let readings: Reading[] = [];
let alerts: Alert[] = [];
let settings: ServerSettings = { ...DEFAULT_SETTINGS };
let storageTimer: ReturnType<typeof setInterval> | undefined;

function validState(state: PicoState): boolean {
    return Number.isFinite(state.temperature) && Number.isFinite(state.moisture) && Number.isFinite(state.light)
        && state.temperature >= -50 && state.temperature <= 100 && state.moisture >= 0 && state.moisture <= 100 && state.light >= -2 && state.light <= 200_000;
}

function retentionCutoff() {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - settings.retentionMonths);
    return cutoff.getTime();
}

function pruneReadings() {
    const cutoff = retentionCutoff();
    readings = readings.filter(reading => new Date(reading.recordedAt).getTime() >= cutoff);
}

function isTimeInRange(time: string, start: string, end: string): boolean {
    if (start === end) return true;
    return start < end ? time >= start && time <= end : time >= start || time <= end;
}

function getOutOfRangeItems(pico: Pico): string[] {
    const range = pico.optimalRange;
    if (!range) return [];

    const items: string[] = [];
    const { temperature, moisture, light } = pico.state;

    if (temperature < range.temperature.min || temperature > range.temperature.max) {
        items.push('temperature ' + temperature + '°C (normal ' + range.temperature.min + '~' + range.temperature.max + '°C)');
    }
    if (moisture < range.moisture.min || moisture > range.moisture.max) {
        items.push('moisture ' + moisture + '% (normal ' + range.moisture.min + '~' + range.moisture.max + '%)');
    }

    const currentTime = new Date().toTimeString().slice(0, 5);
    if (isTimeInRange(currentTime, range.light.startTime, range.light.endTime) &&
        (light < range.light.min || light > range.light.max)) {
        items.push('light ' + light + 'lx (normal ' + range.light.min + '~' + range.light.max + 'lx)');
    }
    return items;
}

function updateRangeAlert(pico: Pico) {
    const items = getOutOfRangeItems(pico);
    const existing = pico.rangeAlertId
        ? alerts.find(alert => alert.picoId === pico.id && alert.id === pico.rangeAlertId && !alert.resolved)
        : undefined;

    if (items.length > 0) {
        if (!existing) {
            const alert: Alert = {
                id: crypto.randomUUID(),
                picoId: pico.id,
                message: 'Values out of optimal range: ' + items.join(', '),
                level: 'warning',
                createdAt: new Date().toISOString(),
                resolved: false
            };
            alerts.unshift(alert);
            pico.rangeAlertId = alert.id;
        }
    } else if (existing) {
        existing.resolved = true;
        pico.rangeAlertId = undefined;
    }
    alerts = alerts.slice(0, 500);
}

function persist() {
    pruneReadings();
    fs.mkdirSync(dataDir, { recursive: true });
    const data: PersistedData = { picos: Object.values(picoList).map(pico => pico.export()), readings, alerts, settings };
    const temporaryFile = dataFile + '.tmp';
    fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temporaryFile, dataFile);
}

export class Pico {
    name: string;
    id: string;
    connected: boolean;
    state: PicoState;
    optimalRange?: OptimalRange;
    rangeAlertId?: string;
    updatedAt: string;
    receivedAt: string;

    constructor(pico: PicoType) {
        if (!validState(pico.state)) throw new Error('Invalid sensor state');
        this.name = pico.name;
        this.id = pico.id;
        this.connected = pico.connected;
        this.state = pico.state;
        this.optimalRange = pico.optimalRange;
        this.rangeAlertId = pico.rangeAlertId;
        this.updatedAt = pico.updatedAt ?? new Date().toISOString();
        this.receivedAt = pico.receivedAt ?? this.updatedAt;
    }

    export(): PicoType {
        return {
            name: this.name,
            id: this.id,
            connected: this.connected,
            state: this.state,
            optimalRange: this.optimalRange,
            rangeAlertId: this.rangeAlertId,
            updatedAt: this.updatedAt,
            receivedAt: this.receivedAt
        };
    }

    setState(state: PicoState) {
        if (!validState(state)) throw new Error('Sensor values are outside the allowed range');
        this.state = state;
        this.receivedAt = new Date().toISOString();
        this.updatedAt = this.receivedAt;
        updateRangeAlert(this);
        persist();
    }

    setConnected(connected: boolean) {
        this.connected = connected;
        this.updatedAt = new Date().toISOString();
        if (!connected) alerts.unshift({
            id: crypto.randomUUID(),
            picoId: this.id,
            message: 'Device disconnected',
            level: 'error',
            createdAt: this.updatedAt,
            resolved: false
        });
        persist();
    }

    setOptimalRange(range: OptimalRange) {
        this.optimalRange = range;
        this.rangeAlertId = undefined;
        persist();
    }
}

export const picoList: Record<string, Pico> = {};
export type ReadingPeriod = '24h' | '1d' | '7d' | '30d' | '1y' | 'all';

function periodCutoff(period: ReadingPeriod): number | null {
    if (period === 'all') return null;
    const durationMs: Record<Exclude<ReadingPeriod, 'all'>, number> = {
        '24h': 24 * 60 * 60 * 1000,
        '1d': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000,
        '30d': 30 * 24 * 60 * 60 * 1000,
        '1y': 365 * 24 * 60 * 60 * 1000,
    };
    return Date.now() - durationMs[period];
}

export function getReadings(picoId: string, limit = 100, period: ReadingPeriod = 'all'): Reading[] {
    pruneReadings();
    const cutoff = periodCutoff(period);
    return readings
        .filter(reading => reading.picoId === picoId)
        .filter(reading => cutoff === null || new Date(reading.recordedAt).getTime() >= cutoff)
        .slice(0, Math.min(limit, 10_000));
}
export function getAlerts(): Alert[] { return alerts; }
export function clearTelemetry() { readings = []; alerts = []; persist(); }
export function clearAlerts() {
    alerts = [];
    Object.values(picoList).forEach(pico => { pico.rangeAlertId = undefined; });
    persist();
}
export function getSettings(): ServerSettings { return { ...settings }; }
export function saveLatestReadings() {
    const recordedAt = new Date().toISOString();
    for (const pico of Object.values(picoList)) {
        if (pico.connected) readings.unshift({ picoId: pico.id, ...pico.state, recordedAt });
    }
    persist();
}

function restartStorageScheduler() {
    if (storageTimer) clearInterval(storageTimer);
    storageTimer = setInterval(saveLatestReadings, settings.syncIntervalMinutes * 60_000);
}

export function startStorageScheduler() { restartStorageScheduler(); }

export function updateSettings(next: ServerSettings) {
    settings = { measurementIntervalMinutes: 1, syncIntervalMinutes: next.syncIntervalMinutes, retentionMonths: next.retentionMonths };
    restartStorageScheduler();
    pruneReadings();
    persist();
}

export function loadPersistedData() {
    if (!fs.existsSync(dataFile)) return;
    try {
        const data: PersistedData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        readings = Array.isArray(data.readings) ? data.readings : [];
        alerts = Array.isArray(data.alerts) ? data.alerts : [];
        if (data.settings && Number.isInteger(data.settings.retentionMonths)) {
            settings = {
                measurementIntervalMinutes: 1,
                syncIntervalMinutes: Number.isInteger(data.settings.syncIntervalMinutes) ? data.settings.syncIntervalMinutes : DEFAULT_SETTINGS.syncIntervalMinutes,
                retentionMonths: data.settings.retentionMonths,
            };
        }
        pruneReadings();
        for (const saved of data.picos ?? []) {
            const id = saved.id.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (id) picoList[id] = new Pico({ ...saved, id, connected: false });
        }
    } catch (error) { console.error('[Storage] Saved state could not be loaded:', error); }
}
export function saveState() { persist(); }
