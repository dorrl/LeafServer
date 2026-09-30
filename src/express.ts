import express from 'express';
import http from 'node:http';
import { Pico, clearAlerts, clearTelemetry, getAlerts, getReadings, getSettings, loadPersistedData, picoList, ReadingPeriod, saveState, startStorageScheduler, updateSettings } from './pico.js';
import { OptimalRange, PicoState, PicoType, Respond, ServerSettings } from './types.js';
import { config } from 'dotenv'

config()
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 3000;
const PARENT = process.env.PARENT || ''
const API_KEY = process.env.SMARTFARM_API_KEY;

loadPersistedData();
startStorageScheduler();

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!API_KEY) return res.status(503).json({ error: 'SMARTFARM_API_KEY is not configured' });
    if (req.get('X-API-Key') !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
    next();
}

function cleanId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const id = value.toLowerCase().replace(/[^a-z0-9]/g, '');
    return id.length > 0 && id.length <= 64 ? id : null;
}

function isPicoState(value: unknown): value is PicoState {
    if (!value || typeof value !== 'object') return false;
    const state = value as PicoState;
    return [state.temperature, state.moisture, state.light].every(item => typeof item === 'number' && Number.isFinite(item));
}

function isRange(value: unknown, minAllowed: number, maxAllowed: number): value is { min: number; max: number } {
    if (!value || typeof value !== 'object') return false;
    const range = value as { min?: unknown; max?: unknown };
    return typeof range.min === 'number' && Number.isFinite(range.min)
        && typeof range.max === 'number' && Number.isFinite(range.max)
        && range.min <= range.max
        && range.min >= minAllowed && range.max <= maxAllowed;
}

function isOptimalRange(value: unknown): value is OptimalRange {
    if (!value || typeof value !== 'object') return false;
    const range = value as Partial<OptimalRange>;
    return isRange(range.temperature, -50, 100)
        && isRange(range.moisture, 0, 100)
        && isRange(range.light, -2, 200_000)
        && typeof range.light.minDurationHours === 'number'
        && Number.isFinite(range.light.minDurationHours)
        && typeof range.light.maxDurationHours === 'number'
        && Number.isFinite(range.light.maxDurationHours)
        && range.light.minDurationHours >= 0
        && range.light.maxDurationHours <= 24
        && range.light.minDurationHours <= range.light.maxDurationHours;
}

app.get(PARENT + '/', (_req, res) => res.json({ state: 200, service: 'smartfarm-server' }));

app.get(PARENT + '/state', (_req, res) => {
    const pico: PicoType[] = Object.values(picoList).map(device => device.export());
    const response: Respond = { state: 200, source: 'latest-received', servedAt: new Date().toISOString(), pico };
    res.json(response);
});

app.get(PARENT + '/picos/:id/state', (req, res) => {
    const id = cleanId(req.params.id);
    if (!id || !picoList[id]) return res.status(404).json({ error: 'Pico not found' });
    res.json({ state: 200, pico: picoList[id].export() });
});

app.post(PARENT + '/picos/:id/setName', requireApiKey, (req, res) => {
    const id = cleanId(req.params.id);
    if (!id || !picoList[id]) return res.status(404).json({ error: 'Pico not found' });

    const body = req.body as { name?: unknown };
    if (typeof body.name !== 'string') return res.status(400).json({ error: 'name must be a string' });

    const name = body.name.trim();
    if (!name) return res.status(400).json({ error: 'name must not be empty' });
    if (name.length > 80) return res.status(400).json({ error: 'name must be 80 characters or fewer' });

    const pico = picoList[id];
    pico.name = name;
    pico.updatedAt = new Date().toISOString();
    saveState();
    res.json({ state: 200, pico: pico.export() });
});

app.post(PARENT + '/picos/:id/optimalRange', requireApiKey, (req, res) => {
    const id = cleanId(req.params.id);
    if (!id || !picoList[id]) return res.status(404).json({ error: 'Pico not found' });
    if (!isOptimalRange(req.body)) {
        return res.status(400).json({
            error: 'Invalid optimal range. temperature/moisture/light require min/max, and light also requires minDurationHours/maxDurationHours from 0 to 24.'
        });
    }

    picoList[id].setOptimalRange(req.body);
    res.json({ state: 200, pico: picoList[id].export() });
});

app.get(PARENT + '/picos/:id/readings', (req, res) => {
    const id = cleanId(req.params.id);
    if (!id || !picoList[id]) return res.status(404).json({ error: 'Pico not found' });
    const requestedLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 720)) : 100;
    const period = req.query.period ?? 'all';
    const validPeriods: ReadingPeriod[] = ['24h', '1d', '7d', '30d', '1y', 'all'];
    if (typeof period !== 'string' || !validPeriods.includes(period as ReadingPeriod)) {
        return res.status(400).json({ error: 'period must be one of: 24h, 1d, 7d, 30d, 1y, all' });
    }
    res.json({ state: 200, readings: getReadings(id, limit, period as ReadingPeriod) });
});

app.get(PARENT + '/notifications', (_req, res) => {
    res.json({ state: 200, notifications: getAlerts().slice(0, 20) });
});

app.delete(PARENT + '/notifications/delete', requireApiKey, (_req, res) => {
    clearAlerts();
    res.json({ state: 200, message: 'Notifications were deleted.' });
});

app.delete(PARENT + '/data', requireApiKey, (_req, res) => {
    clearTelemetry();
    res.json({ state: 200, message: 'Saved readings and alerts were deleted.' });
});

app.get(PARENT + '/settings', (_req, res) => res.json({ state: 200, settings: getSettings() }));

app.post(PARENT + '/settings', requireApiKey, async (req, res) => {
    const body = req.body as Partial<ServerSettings>;
    const measurementIntervalMinutes = body.measurementIntervalMinutes;
    const syncIntervalMinutes = body.syncIntervalMinutes;
    const retentionMonths = body.retentionMonths;
    if (measurementIntervalMinutes !== 1) return res.status(400).json({ error: 'measurementIntervalMinutes is fixed at 1' });
    if (typeof syncIntervalMinutes !== 'number' || !Number.isInteger(syncIntervalMinutes) || syncIntervalMinutes < 1 || syncIntervalMinutes > 1440) {
        return res.status(400).json({ error: 'syncIntervalMinutes must be an integer from 1 to 1440' });
    }
    if (typeof retentionMonths !== 'number' || !Number.isInteger(retentionMonths) || retentionMonths < 1 || retentionMonths > 60) {
        return res.status(400).json({ error: 'retentionMonths must be an integer from 1 to 60' });
    }
    updateSettings({ measurementIntervalMinutes, syncIntervalMinutes, retentionMonths });
    res.json({ state: 200, settings: getSettings() });
});

app.post(PARENT + '/setPico', requireApiKey, (req, res) => {
    const body = req.body as Partial<PicoType>;
    const id = cleanId(body?.id);
    if (!id) return res.status(400).json({ error: 'A valid Pico ID is required' });
    if (body.state !== undefined && !isPicoState(body.state)) return res.status(400).json({ error: 'Invalid sensor state' });

    try {
        let pico = picoList[id];
        if (!pico) {
            if (!body.state) return res.status(400).json({ error: 'State is required when creating a Pico' });
            pico = new Pico({ id, name: typeof body.name === 'string' ? body.name.slice(0, 80) : 'Pico-' + id, connected: Boolean(body.connected), state: body.state });
            picoList[id] = pico;
        } else {
            if (typeof body.name === 'string') pico.name = body.name.slice(0, 80);
            if (typeof body.connected === 'boolean') pico.setConnected(body.connected);
            if (body.state) pico.setState(body.state);
        }
        saveState();
        res.json({ state: 200, pico: pico.export() });
    } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request' });
    }
});

http.createServer(app).listen(PORT, '0.0.0.0', () => {
    if (!API_KEY) console.warn('[Security] Write endpoints are disabled until SMARTFARM_API_KEY is configured.');
    console.log('SmartFarm HTTP server is listening on port ' + PORT);
});
