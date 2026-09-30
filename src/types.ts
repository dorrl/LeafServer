export type PicoState = {
    temperature: number;
    moisture: number;
    light: number;
};

export type OptimalRange = {
    temperature: { min: number; max: number };
    moisture: { min: number; max: number };
    light: { min: number; max: number; minDurationHours: number; maxDurationHours: number };
};

export type PicoType = {
    name: string;
    id: string;
    connected: boolean;
    state: PicoState;
    optimalRange?: OptimalRange;
    rangeAlertId?: string;
    lightDurationDate?: string;
    lightDurationMinutes?: number;
    lightSampleAt?: string;
    updatedAt?: string;
    receivedAt?: string;
};

export type Reading = PicoState & {
    picoId: string;
    recordedAt: string;
};

export type AlertLevel = 'warning' | 'error' | 'info';

export type Alert = {
    id: string;
    picoId: string;
    message: string;
    level: AlertLevel;
    createdAt: string;
    resolved: boolean;
};

export type ServerSettings = {
    measurementIntervalMinutes: number;
    syncIntervalMinutes: number;
    retentionMonths: number;
};

export type Respond = {
    state: number;
    source: 'latest-received';
    servedAt: string;
    pico: PicoType[];
};
