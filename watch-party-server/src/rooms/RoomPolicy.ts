// Copyright (C) 2017-2026 Smart code 203358507

import { REQUIRED_CAPABILITIES, type PlayerCapabilities, type RoomPolicy } from '../protocol/types.ts';

/**
 * MVP readiness policy (plan section 10).
 *
 * The host must be ready; whether guests gate the first start is the host's
 * choice. Sustained buffering pauses the room by default so nobody silently
 * misses content. Clients debounce short buffering blips before reporting them.
 */
export const DEFAULT_ROOM_POLICY: RoomPolicy = {
    requireAllReadyToStart: true,
    pauseOnGuestBuffering: true,
    pauseOnHostStall: true,
};

export const normalizeRoomPolicy = (policy: Partial<RoomPolicy> | undefined): RoomPolicy => ({
    requireAllReadyToStart: policy?.requireAllReadyToStart ?? DEFAULT_ROOM_POLICY.requireAllReadyToStart,
    pauseOnGuestBuffering: policy?.pauseOnGuestBuffering ?? DEFAULT_ROOM_POLICY.pauseOnGuestBuffering,
    pauseOnHostStall: policy?.pauseOnHostStall ?? DEFAULT_ROOM_POLICY.pauseOnHostStall,
});

/**
 * A client lacking a required capability may still join, but only as an
 * observer. It must never be counted as synchronized (plan section 8.1).
 */
export const missingCapabilities = (capabilities: PlayerCapabilities): string[] =>
    REQUIRED_CAPABILITIES.filter((name) => capabilities[name] !== true);

export const isSupportedClient = (capabilities: PlayerCapabilities): boolean =>
    missingCapabilities(capabilities).length === 0;
