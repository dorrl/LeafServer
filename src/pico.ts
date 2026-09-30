import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Alert, PicoState, PicoType, Reading, ServerSettings } from './types.js';

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

function addAlert(pico: Pico) {
    const problems: Array<[string, Alert['level']]> = [];
    if (pico.state.temperature < 15 || pico.state.temperature > 30) problems.push([`Temperature out of range: ${pico.state.temperature}°C`, 'warning']);
    if (pico.state.moisture < 30) problems.push([`Soil moisture is low: ${pico.state.moisture}%`, 'warning']);
    for (const [message, level] of problems) {
        if (!alerts.some(alert => alert.picoId === pico.id && alert.message === message && !alert.resolved)) {
            alerts.unshift({ id: crypto.randomUUID(), picoId: pico.id, message, level, createdAt: new Date().toISOString(), resolved: false });
        }
    }
    if (!problems.length) alerts.filter(alert => alert.picoId === pico.id && !alert.resolved).forEach(alert => { alert.resolved = true; });
    alerts = alerts.slice(0, 500);
}

function persist() {
    pruneReadings();
    fs.mkdirSync(dataDir, { recursive: true });
    const data: PersistedData = { picos: Object.values(picoList).map(pico => pico.export()), readings, alerts, settings };
    const temporaryFile = `${dataFile}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temporaryFile, dataFile);
}

export class Pico {
    name: string;
    id: string;
    connected: boolean;
    state: PicoState;
    updatedAt: string;
    receivedAt: string;
    constructor(pico: PicoType) {
        if (!validState(pico.state)) throw new Error('Invalid sensor state');
        this.name = pico.name; this.id = pico.id; this.connected = pico.connected; this.state = pico.state;
        this.updatedAt = pico.updatedAt ?? new Date().toISOString();
        // Older saved files do not have receivedAt, so retain their known timestamp.
        this.receivedAt = pico.receivedAt ?? this.updatedAt;
    }
    export(): PicoType {
        return { name: this.name, id: this.id, connected: this.connected, state: this.state, updatedAt: this.updatedAt, receivedAt: this.receivedAt };
    }
    setState(state: PicoState) {
        if (!validState(state)) throw new Error('Sensor values are outside the allowed range');
        this.state = state;
        this.receivedAt = new Date().toISOString();
        this.updatedAt = this.receivedAt;
        addAlert(this); persist();
    }
    setConnected(connected: boolean) {
        this.connected = connected; this.updatedAt = new Date().toISOString();
        if (!connected) alerts.unshift({ id: crypto.randomUUID(), picoId: this.id, message: 'Device disconnected', level: 'error', createdAt: this.updatedAt, resolved: false });
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
export function clearAlerts() { alerts = []; persist(); }
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
