// Copyright (C) 2017-2026 Smart code 203358507

import { ProtocolError } from '../protocol/errors.ts';
import type { RoomCloseReason } from '../protocol/types.ts';
import { Room, type CreateRoomInput, type RoomOptions } from './Room.ts';

/**
 * In-memory room registry.
 *
 * One process, one `Map`. Redis is deliberately absent until multiple instances
 * or restart survival are actually required (plan section 15.1).
 */

export type RoomStoreOptions = {
    maxRooms: number;
    roomTtlMs: number;
    roomIdleTtlMs: number;
    maxParticipantsPerRoom: number;
    commandHistorySize: number;
    defaultLeadMs: number;
    hostGraceMs: number;
};

export type ExpiredRoom = { room: Room; reason: RoomCloseReason };

export class RoomStore {
    private readonly rooms = new Map<string, Room>();
    private readonly options: RoomStoreOptions;

    constructor(options: RoomStoreOptions) {
        this.options = options;
    }

    get size(): number {
        return this.rooms.size;
    }

    create(input: CreateRoomInput, nowMs: number): Room {
        if (this.rooms.size >= this.options.maxRooms) {
            throw new ProtocolError('ROOM_LIMIT_REACHED', 'the server is not accepting new rooms');
        }
        const roomOptions: RoomOptions = {
            nowMs,
            ttlMs: this.options.roomTtlMs,
            maxParticipants: this.options.maxParticipantsPerRoom,
            commandHistorySize: this.options.commandHistorySize,
            defaultLeadMs: this.options.defaultLeadMs,
            hostGraceMs: this.options.hostGraceMs,
        };
        const room = Room.create(input, roomOptions);
        this.rooms.set(room.roomId, room);
        return room;
    }

    get(roomId: string): Room | undefined {
        return this.rooms.get(roomId);
    }

    /**
     * Looks up a room for a join attempt.
     *
     * Missing, closed and expired rooms all raise the same error, so a caller
     * cannot use timing or error codes to enumerate live room ids.
     */
    requireOpen(roomId: string, nowMs: number): Room {
        const room = this.rooms.get(roomId);
        if (room === undefined || room.closed || nowMs >= room.expiresAtServerMs) {
            throw new ProtocolError('ROOM_NOT_FOUND', 'room is no longer available');
        }
        return room;
    }

    delete(roomId: string): void {
        this.rooms.delete(roomId);
    }

    list(): Room[] {
        return [...this.rooms.values()];
    }

    /**
     * Removes rooms that hit their absolute TTL or went idle with nobody
     * connected, and returns them so the caller can notify any stragglers.
     */
    sweep(nowMs: number): ExpiredRoom[] {
        const expired: ExpiredRoom[] = [];
        for (const room of this.rooms.values()) {
            if (room.closed) {
                expired.push({ room, reason: room.closeReason ?? 'expired' });
            } else if (room.isExpired(nowMs, this.options.roomIdleTtlMs)) {
                room.close('expired');
                expired.push({ room, reason: 'expired' });
            }
        }
        for (const { room } of expired) {
            this.rooms.delete(room.roomId);
        }
        return expired;
    }

    /** Applies the host-grace freeze to every room. Returns rooms that changed. */
    applyHostGrace(nowMs: number): Room[] {
        return this.list().filter((room) => room.freezeForHostGrace(nowMs));
    }

    closeAll(reason: RoomCloseReason): Room[] {
        const rooms = this.list();
        for (const room of rooms) {
            room.close(reason);
        }
        this.rooms.clear();
        return rooms;
    }
}
