import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alert } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../data');
const tokenFile = path.join(dataDir, 'fcm-tokens.json');
type FcmDevice = { token: string; serverId: string };
type FcmTokenStore = { devices: FcmDevice[] };
let devices = loadDevices();
let initialized = false;
let initializationFailed = false;

function loadDevices(): FcmDevice[] {
    if (!fs.existsSync(tokenFile)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as FcmTokenStore;
        return Array.isArray(data.devices)
            ? data.devices.filter(device =>
                device &&
                typeof device.token === 'string' &&
                device.token.length > 0 &&
                typeof device.serverId === 'string' &&
                device.serverId.length > 0
            )
            : [];
    } catch (error) {
        console.error('[FCM] Token store could not be loaded:', error instanceof Error ? error.message : error);
        return [];
    }
}

function saveDevices() {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporaryFile = tokenFile + '.tmp';
    fs.writeFileSync(temporaryFile, JSON.stringify({ devices }, null, 2), 'utf8');
    fs.renameSync(temporaryFile, tokenFile);
}

function ensureInitialized(): boolean {
    if (initialized) return true;
    if (initializationFailed) return false;

    try {
        if (getApps().length === 0) {
            const projectId = process.env.FCM_PROJECT_ID;
            const clientEmail = process.env.FCM_CLIENT_EMAIL;
            const privateKey = process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, '\n');

            if (projectId && clientEmail && privateKey) {
                initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
            } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                initializeApp();
            } else {
                console.warn('[FCM] FCM is disabled: set FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY (or GOOGLE_APPLICATION_CREDENTIALS).');
                initializationFailed = true;
                return false;
            }
        }

        initialized = true;
        console.log('[FCM] Firebase Admin initialized');
        return true;
    } catch (error) {
        initializationFailed = true;
        console.error('[FCM] Firebase Admin initialization failed:', error instanceof Error ? error.message : error);
        return false;
    }
}

export function registerFcmToken(token: string, serverId: string): number {
    const normalizedToken = token.trim();
    const normalizedServerId = serverId.trim();
    if (!normalizedToken || normalizedToken.length > 4096) throw new Error('Invalid FCM token');
    if (!normalizedServerId) throw new Error('Invalid serverId');

    const existing = devices.find(device => device.token === normalizedToken);
    if (existing) {
        existing.serverId = normalizedServerId;
    } else {
        devices.push({ token: normalizedToken, serverId: normalizedServerId });
    }
    saveDevices();
    return devices.length;
}

export function unregisterFcmToken(token: string): number {
    const normalized = token.trim();
    const nextDevices = devices.filter(device => device.token !== normalized);
    if (nextDevices.length !== devices.length) {
        devices = nextDevices;
        saveDevices();
    }
    return devices.length;
}

export function getFcmTokenCount(): number {
    return devices.length;
}

export async function sendFcmNotification(alert: Alert, picoName: string): Promise<void> {
    if (devices.length === 0 || !ensureInitialized()) return;

    const messaging = getMessaging();
    const results = await Promise.all(devices.map(async device => {
        try {
            await messaging.send({
                token: device.token,
                notification: {
                    title: picoName,
                    body: alert.message,
                },
                data: {
                    serverId: device.serverId,
                    picoId: alert.picoId,
                },
            });
            return { token: device.token, success: true, code: undefined };
        } catch (error) {
            return {
                token: device.token,
                success: false,
                code: error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : undefined,
            };
        }
    }));

    const invalidTokens = results
        .filter(result => !result.success)
        .filter(result => result.code === 'messaging/registration-token-not-registered' || result.code === 'messaging/invalid-registration-token')
        .map(result => result.token);

    if (invalidTokens.length > 0) {
        const invalidSet = new Set(invalidTokens);
        devices = devices.filter(device => !invalidSet.has(device.token));
        saveDevices();
        console.log('[FCM] Removed ' + invalidTokens.length + ' invalid device token(s)');
    }

    const failureCount = results.filter(result => !result.success).length;
    if (failureCount > 0) {
        console.error('[FCM] Notification send completed with ' + failureCount + ' failure(s)');
    }
}
