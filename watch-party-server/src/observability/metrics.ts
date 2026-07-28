// Copyright (C) 2017-2026 Smart code 203358507

/**
 * Minimal Prometheus text-format registry.
 *
 * A dependency-free registry keeps the service's runtime surface at exactly one
 * package (`ws`). Only counters, gauges and fixed-bucket histograms are needed
 * for the metrics listed in the plan (section 15.2).
 */

type LabelValues = Record<string, string>;

const escapeLabelValue = (value: string): string =>
    value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

const serializeLabels = (labels: LabelValues): string => {
    const entries = Object.entries(labels);
    if (entries.length === 0) {
        return '';
    }
    const body = entries
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
        .join(',');
    return `{${body}}`;
};

const labelKey = (labels: LabelValues): string => serializeLabels(labels);

class Counter {
    readonly name: string;
    readonly help: string;
    private readonly values = new Map<string, { labels: LabelValues; value: number }>();

    constructor(name: string, help: string) {
        this.name = name;
        this.help = help;
    }

    inc(labels: LabelValues = {}, amount = 1): void {
        const key = labelKey(labels);
        const existing = this.values.get(key);
        if (existing === undefined) {
            this.values.set(key, { labels, value: amount });
        } else {
            existing.value += amount;
        }
    }

    get(labels: LabelValues = {}): number {
        return this.values.get(labelKey(labels))?.value ?? 0;
    }

    render(): string[] {
        const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
        if (this.values.size === 0) {
            lines.push(`${this.name} 0`);
        }
        for (const { labels, value } of this.values.values()) {
            lines.push(`${this.name}${serializeLabels(labels)} ${value}`);
        }
        return lines;
    }
}

class Gauge {
    readonly name: string;
    readonly help: string;
    private value = 0;

    constructor(name: string, help: string) {
        this.name = name;
        this.help = help;
    }

    set(value: number): void {
        this.value = value;
    }

    inc(amount = 1): void {
        this.value += amount;
    }

    dec(amount = 1): void {
        this.value -= amount;
    }

    get(): number {
        return this.value;
    }

    render(): string[] {
        return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, `${this.name} ${this.value}`];
    }
}

class Histogram {
    readonly name: string;
    readonly help: string;
    private readonly bucketBounds: number[];
    private readonly bucketCounts: number[];
    private sum = 0;
    private count = 0;

    constructor(name: string, help: string, bucketBounds: number[]) {
        this.name = name;
        this.help = help;
        this.bucketBounds = [...bucketBounds].sort((a, b) => a - b);
        this.bucketCounts = new Array<number>(this.bucketBounds.length).fill(0);
    }

    observe(value: number): void {
        if (!Number.isFinite(value)) {
            return;
        }
        this.sum += value;
        this.count += 1;
        for (let index = 0; index < this.bucketBounds.length; index += 1) {
            const bound = this.bucketBounds[index];
            if (bound !== undefined && value <= bound) {
                this.bucketCounts[index] = (this.bucketCounts[index] ?? 0) + 1;
            }
        }
    }

    getCount(): number {
        return this.count;
    }

    render(): string[] {
        const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
        for (let index = 0; index < this.bucketBounds.length; index += 1) {
            lines.push(`${this.name}_bucket{le="${this.bucketBounds[index]}"} ${this.bucketCounts[index] ?? 0}`);
        }
        lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`);
        lines.push(`${this.name}_sum ${this.sum}`);
        lines.push(`${this.name}_count ${this.count}`);
        return lines;
    }
}

export type Metrics = ReturnType<typeof createMetrics>;

/** Drift buckets in milliseconds, aligned with the correction thresholds in drift decisions. */
const DRIFT_BUCKETS_MS = [50, 100, 150, 250, 500, 1000, 2000, 5000];

/** Command handling latency in milliseconds. */
const COMMAND_LATENCY_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 1000];

export const createMetrics = () => {
    const connectionsOpen = new Gauge('watch_party_connections_open', 'Currently open WebSocket connections.');
    const roomsOpen = new Gauge('watch_party_rooms_open', 'Currently live rooms.');
    const participantsOpen = new Gauge('watch_party_participants_open', 'Currently connected room participants.');
    const connectionsTotal = new Counter('watch_party_connections_total', 'Accepted WebSocket connections.');
    const connectionsRejectedTotal = new Counter('watch_party_connections_rejected_total', 'Rejected WebSocket upgrades by reason.');
    const roomsCreatedTotal = new Counter('watch_party_rooms_created_total', 'Rooms created.');
    const roomsClosedTotal = new Counter('watch_party_rooms_closed_total', 'Rooms closed by reason.');
    const joinsTotal = new Counter('watch_party_joins_total', 'Successful room joins.');
    const reconnectsTotal = new Counter('watch_party_reconnects_total', 'Successful session resumes.');
    const invalidMessagesTotal = new Counter('watch_party_invalid_messages_total', 'Rejected inbound messages by error code.');
    const rateLimitedTotal = new Counter('watch_party_rate_limited_total', 'Messages dropped by a rate limiter, by bucket.');
    const commandsTotal = new Counter('watch_party_commands_total', 'Applied host playback commands by action.');
    const commandsRejectedTotal = new Counter('watch_party_commands_rejected_total', 'Rejected playback commands by reason.');
    const mediaChangesTotal = new Counter('watch_party_media_changes_total', 'Applied media revisions.');
    const commandLatency = new Histogram('watch_party_command_latency_ms', 'Server-side handling latency for host commands.', COMMAND_LATENCY_BUCKETS_MS);
    const guestDrift = new Histogram('watch_party_guest_drift_ms', 'Absolute guest drift reported through observations.', DRIFT_BUCKETS_MS);

    const collectors = [
        connectionsOpen,
        roomsOpen,
        participantsOpen,
        connectionsTotal,
        connectionsRejectedTotal,
        roomsCreatedTotal,
        roomsClosedTotal,
        joinsTotal,
        reconnectsTotal,
        invalidMessagesTotal,
        rateLimitedTotal,
        commandsTotal,
        commandsRejectedTotal,
        mediaChangesTotal,
        commandLatency,
        guestDrift,
    ];

    return {
        connectionsOpen,
        roomsOpen,
        participantsOpen,
        connectionsTotal,
        connectionsRejectedTotal,
        roomsCreatedTotal,
        roomsClosedTotal,
        joinsTotal,
        reconnectsTotal,
        invalidMessagesTotal,
        rateLimitedTotal,
        commandsTotal,
        commandsRejectedTotal,
        mediaChangesTotal,
        commandLatency,
        guestDrift,
        render(): string {
            return `${collectors.flatMap((collector) => collector.render()).join('\n')}\n`;
        },
    };
};
