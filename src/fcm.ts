import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alert } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../data');
const tokenFile = path.join(dataDir, 'fcm-tokens.json');
const SERVER_ID = process.env.LEAF_SERVER_ID ?? process.env.SMARTFARM_SERVER_ID ?? 'default';
const SERVER_NAME = process.env.LEAF_SERVER_NAME ?? process.env.LEAF_SERVER_ID ?? process.env.SMARTFARM_SERVER_ID ?? 'Leaf';

type FcmTokenStore = { tokens: string[] };
let tokens = loadTokens();
let initialized = false;
let initializationFailed = false;

function loadTokens(): string[] {
    if (!fs.existsSync(tokenFile)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as FcmTokenStore;
        return Array.isArray(data.tokens)
            ? [...new Set(data.tokens.filter(token => typeof token === 'string' && token.length > 0))]
            : [];
    } catch (error) {
        console.error('[FCM] Token store could not be loaded:', error instanceof Error ? error.message : error);
        return [];
    }
}

function saveTokens() {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporaryFile = tokenFile + '.tmp';
    fs.writeFileSync(temporaryFile, JSON.stringify({ tokens }, null, 2), 'utf8');
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

export function registerFcmToken(token: string): number {
    const normalized = token.trim();
    if (!normalized || normalized.length > 4096) throw new Error('Invalid FCM token');
    if (!tokens.includes(normalized)) {
        tokens.push(normalized);
        saveTokens();
    }
    return tokens.length;
}

export function unregisterFcmToken(token: string): number {
    const normalized = token.trim();
    const nextTokens = tokens.filter(item => item !== normalized);
    if (nextTokens.length !== tokens.length) {
        tokens = nextTokens;
        saveTokens();
    }
    return tokens.length;
}

export function getFcmTokenCount(): number {
    return tokens.length;
}

export async function sendFcmNotification(alert: Alert, picoName: string): Promise<void> {
    if (tokens.length === 0 || !ensureInitialized()) return;

    const response = await getMessaging().sendEachForMulticast({
        tokens,
        notification: {
            title: SERVER_NAME + ' · ' + picoName,
            body: alert.message,
        },
        data: {
            serverId: SERVER_ID,
            picoId: alert.picoId,
            alertId: alert.id,
        },
    });

    const invalidTokens = response.responses
        .map((result, index) => result.success ? null : ({ token: tokens[index], code: result.error?.code }))
        .filter((item): item is { token: string; code?: string } => item !== null)
        .filter(item => item.code === 'messaging/registration-token-not-registered' || item.code === 'messaging/invalid-registration-token')
        .map(item => item.token);

    if (invalidTokens.length > 0) {
        const invalidSet = new Set(invalidTokens);
        tokens = tokens.filter(token => !invalidSet.has(token));
        saveTokens();
        console.log('[FCM] Removed ' + invalidTokens.length + ' invalid device token(s)');
    }

    if (response.failureCount > 0) {
        console.error('[FCM] Notification send completed with ' + response.failureCount + ' failure(s)');
    }
}
