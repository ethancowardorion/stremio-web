// Copyright (C) 2017-2026 Smart code 203358507

import { REQUIRED_CAPABILITIES, type PlayerCapabilities, type RoomPolicy } from '../protocol/types.ts';

/**
 * MVP readiness policy (plan section 10).
 *
 * The host must be ready; whether guests gate the first start is the host's
 * choice. Nothing auto-pauses the room for guest buffering, because a slow or
 * hostile guest must not be able to hold the room hostage.
 */
export const DEFAULT_ROOM_POLICY: RoomPolicy = {
    requireAllReadyToStart: true,
    pauseOnGuestBuffering: false,
    pauseOnHostStall: true,
};

export const normalizeRoomPolicy = (policy: Partial<RoomPolicy> | undefined): RoomPolicy => ({
    requireAllReadyToStart: policy?.requireAllReadyToStart ?? DEFAULT_ROOM_POLICY.requireAllReadyToStart,
    // Not configurable in MVP: accepting `true` here would promise behaviour the
    // service does not implement yet.
    pauseOnGuestBuffering: DEFAULT_ROOM_POLICY.pauseOnGuestBuffering,
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
