import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Alert, OptimalRange, PicoState, PicoType, Reading, ServerSettings } from './types.js';
import { sendFcmNotification } from './fcm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../data');
const dataFile = path.join(dataDir, 'leaf-state.json');
const legacyDataFile = path.join(dataDir, 'smartfarm-state.json');
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

function isLightInRange(pico: Pico): boolean {
    const range = pico.optimalRange;
    if (!range) return false;
    return pico.state.light >= range.light.min && pico.state.light <= range.light.max;
}

function getDurationViolation(pico: Pico, durationMinutes: number, dayEnded: boolean): string | undefined {
    const range = pico.optimalRange;
    if (!range) return undefined;
    const durationHours = durationMinutes / 60;
    if (durationHours > range.light.maxDurationHours) {
        return 'light duration ' + durationHours.toFixed(1) + 'h (normal ' + range.light.minDurationHours + '~' + range.light.maxDurationHours + 'h/day)';
    }
    if (dayEnded && durationHours < range.light.minDurationHours) {
        return 'light duration ' + durationHours.toFixed(1) + 'h (normal ' + range.light.minDurationHours + '~' + range.light.maxDurationHours + 'h/day)';
    }
    return undefined;
}

function getOutOfRangeItems(pico: Pico, lightDurationMinutes = pico.lightDurationMinutes, dayEnded = false): string[] {
    const range = pico.optimalRange;
    if (!range) return [];
    const items: string[] = [];
    const { temperature, moisture } = pico.state;
    if (temperature < range.temperature.min || temperature > range.temperature.max) {
        items.push('temperature ' + temperature + '°C (normal ' + range.temperature.min + '~' + range.temperature.max + '°C)');
    }
    if (moisture < range.moisture.min || moisture > range.moisture.max) {
        items.push('moisture ' + moisture + '% (normal ' + range.moisture.min + '~' + range.moisture.max + '%)');
    }
    const durationViolation = getDurationViolation(pico, lightDurationMinutes, dayEnded);
    if (durationViolation) items.push(durationViolation);
    return items;
}

function createRangeAlert(pico: Pico, items: string[]) {
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
    void sendFcmNotification(alert, pico.name).catch(error => {
        console.error('[FCM] Failed to send notification:', error instanceof Error ? error.message : error);
    });
}

function updateRangeAlert(pico: Pico, dayEnded = false, previousDayDurationMinutes?: number) {
    const previousDayViolation = previousDayDurationMinutes === undefined
        ? undefined
        : getDurationViolation(pico, previousDayDurationMinutes, true);

    const existing = pico.rangeAlertId
        ? alerts.find(alert => alert.picoId === pico.id && alert.id === pico.rangeAlertId && !alert.resolved)
        : undefined;

    if (dayEnded && existing) {
        existing.resolved = true;
        pico.rangeAlertId = undefined;
    }

    if (previousDayViolation) {
        createRangeAlert(pico, [previousDayViolation]);
        pico.rangeAlertId = undefined;
    }

    const activeItems = getOutOfRangeItems(pico, pico.lightDurationMinutes, false);
    const activeExisting = pico.rangeAlertId
        ? alerts.find(alert => alert.picoId === pico.id && alert.id === pico.rangeAlertId && !alert.resolved)
        : undefined;

    if (activeItems.length > 0) {
        if (!activeExisting) createRangeAlert(pico, activeItems);
    } else if (activeExisting) {
        activeExisting.resolved = true;
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
    lightDurationDate: string;
    lightDurationMinutes: number;
    lightSampleAt: string;
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
        const now = new Date().toISOString();
        this.updatedAt = pico.updatedAt ?? now;
        this.receivedAt = pico.receivedAt ?? this.updatedAt;
        this.lightDurationDate = pico.lightDurationDate ?? this.receivedAt.slice(0, 10);
        this.lightDurationMinutes = Number.isFinite(pico.lightDurationMinutes) ? pico.lightDurationMinutes! : 0;
        this.lightSampleAt = pico.lightSampleAt ?? this.receivedAt;
    }

    export(): PicoType {
        return {
            name: this.name,
            id: this.id,
            connected: this.connected,
            state: this.state,
            optimalRange: this.optimalRange,
            rangeAlertId: this.rangeAlertId,
            lightDurationDate: this.lightDurationDate,
            lightDurationMinutes: this.lightDurationMinutes,
            lightSampleAt: this.lightSampleAt,
            updatedAt: this.updatedAt,
            receivedAt: this.receivedAt
        };
    }

    setState(state: PicoState) {
        if (!validState(state)) throw new Error('Sensor values are outside the allowed range');
        const receivedAt = new Date().toISOString();
        const previousSampleAt = new Date(this.lightSampleAt).getTime();
        const currentSampleAt = new Date(receivedAt).getTime();
        const currentDate = receivedAt.slice(0, 10);
        let dayEnded = false;
        let previousDayDurationMinutes: number | undefined;

        if (Number.isFinite(previousSampleAt) && currentSampleAt > previousSampleAt && this.optimalRange) {
            const elapsedMinutes = Math.min((currentSampleAt - previousSampleAt) / 60_000, 5);
            if (this.lightDurationDate === currentDate) {
                if (isLightInRange(this)) this.lightDurationMinutes += elapsedMinutes;
            } else {
                dayEnded = true;
                previousDayDurationMinutes = this.lightDurationMinutes;
                this.lightDurationDate = currentDate;
                this.lightDurationMinutes = 0;
            }
        } else if (this.lightDurationDate !== currentDate) {
            dayEnded = true;
            previousDayDurationMinutes = this.lightDurationMinutes;
            this.lightDurationDate = currentDate;
            this.lightDurationMinutes = 0;
        }

        this.state = state;
        this.receivedAt = receivedAt;
        this.updatedAt = receivedAt;
        this.lightSampleAt = receivedAt;
        updateRangeAlert(this, dayEnded, previousDayDurationMinutes);
        persist();
    }

    setConnected(connected: boolean) {
        this.connected = connected;
        this.updatedAt = new Date().toISOString();
        if (!connected) {
            const alert: Alert = {
                id: crypto.randomUUID(),
                picoId: this.id,
                message: 'Device disconnected',
                level: 'error',
                createdAt: this.updatedAt,
                resolved: false
            };
            alerts.unshift(alert);
            void sendFcmNotification(alert, this.name).catch(error => {
                console.error('[FCM] Failed to send notification:', error instanceof Error ? error.message : error);
            });
        }
        persist();
    }

    setOptimalRange(range: OptimalRange) {
        if (this.rangeAlertId) {
            const alert = alerts.find(item => item.id === this.rangeAlertId && !item.resolved);
            if (alert) alert.resolved = true;
        }
        this.optimalRange = range;
        this.rangeAlertId = undefined;
        const now = new Date().toISOString();
        this.lightDurationDate = now.slice(0, 10);
        this.lightDurationMinutes = 0;
        this.lightSampleAt = now;
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
export function clearTelemetry() {
    readings = [];
    alerts = [];
    Object.values(picoList).forEach(pico => {
        pico.rangeAlertId = undefined;
        const now = new Date().toISOString();
        pico.lightDurationDate = now.slice(0, 10);
        pico.lightDurationMinutes = 0;
        pico.lightSampleAt = now;
    });
    persist();
}
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
    const sourceFile = fs.existsSync(dataFile) ? dataFile : legacyDataFile;
    if (!fs.existsSync(sourceFile)) return;
    try {
        const data: PersistedData = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
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
