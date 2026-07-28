// Copyright (C) 2017-2026 Smart code 203358507

import { ProtocolError } from './errors.ts';

/**
 * A dependency-free structural validator.
 *
 * The protocol needs exactly three things a general-purpose schema library would
 * also give us — shape checking, unknown-field rejection and bounded sizes — so
 * a small validator keeps the service at a single runtime dependency while still
 * failing closed. Every validator throws `ProtocolError('VALIDATION_FAILED')`
 * carrying the offending path.
 */

export type Validator<T> = (value: unknown, path: string) => T;

const fail = (path: string, expectation: string): never => {
    throw new ProtocolError('VALIDATION_FAILED', `${path === '' ? 'value' : path} ${expectation}`, {
        details: { path },
    });
};

export const string = (options: { min?: number; max?: number; pattern?: RegExp } = {}): Validator<string> =>
    (value, path) => {
        if (typeof value !== 'string') {
            return fail(path, 'must be a string');
        }
        const { min = 0, max = 4096, pattern } = options;
        if (value.length < min) {
            return fail(path, `must be at least ${min} characters`);
        }
        if (value.length > max) {
            return fail(path, `must be at most ${max} characters`);
        }
        if (pattern !== undefined && !pattern.test(value)) {
            return fail(path, 'has an unexpected format');
        }
        return value;
    };

/**
 * Replaces C0/C1 control characters with spaces without embedding literal
 * control bytes in this source file.
 */
const stripControlCharacters = (value: string): string => {
    let out = '';
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
    }
    return out;
};

/**
 * Trims and collapses whitespace before length checks so that a name made only
 * of spaces cannot satisfy a minimum length. Control characters are replaced
 * rather than rejected so a stray newline in a pasted name is not a hard
 * protocol failure.
 */
export const displayName = (max: number): Validator<string> =>
    (value, path) => {
        if (typeof value !== 'string') {
            return fail(path, 'must be a string');
        }
        const cleaned = stripControlCharacters(value).replace(/\s+/g, ' ').trim();
        if (cleaned.length === 0) {
            return fail(path, 'must not be blank');
        }
        return cleaned.slice(0, max);
    };

export const integer = (options: { min?: number; max?: number } = {}): Validator<number> =>
    (value, path) => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
            return fail(path, 'must be a safe integer');
        }
        const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
        if (value < min || value > max) {
            return fail(path, `must be between ${min} and ${max}`);
        }
        return value;
    };

export const finiteNumber = (options: { min?: number; max?: number } = {}): Validator<number> =>
    (value, path) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return fail(path, 'must be a finite number');
        }
        const { min = -Number.MAX_VALUE, max = Number.MAX_VALUE } = options;
        if (value < min || value > max) {
            return fail(path, `must be between ${min} and ${max}`);
        }
        return value;
    };

export const boolean = (): Validator<boolean> =>
    (value, path) => (typeof value === 'boolean' ? value : fail(path, 'must be a boolean'));

export const literal = <const T extends string>(expected: T): Validator<T> =>
    (value, path) => (value === expected ? expected : fail(path, `must equal ${JSON.stringify(expected)}`));

export const enumeration = <const T extends readonly string[]>(allowed: T): Validator<T[number]> =>
    (value, path) => {
        if (typeof value !== 'string' || !allowed.includes(value)) {
            return fail(path, `must be one of ${allowed.join(', ')}`);
        }
        return value;
    };

export const arrayOf = <T>(item: Validator<T>, options: { max?: number } = {}): Validator<T[]> =>
    (value, path) => {
        if (!Array.isArray(value)) {
            return fail(path, 'must be an array');
        }
        const { max = 64 } = options;
        if (value.length > max) {
            return fail(path, `must contain at most ${max} items`);
        }
        return value.map((entry, index) => item(entry, `${path}[${index}]`));
    };

/** Accepts `undefined` and a missing key; a present `null` still fails. */
export const optional = <T>(inner: Validator<T>): Validator<T | undefined> =>
    (value, path) => (value === undefined ? undefined : inner(value, path));

/** Accepts an explicit `null` in addition to the inner type. */
export const nullable = <T>(inner: Validator<T>): Validator<T | null> =>
    (value, path) => (value === null ? null : inner(value, path));

export const withDefault = <T>(inner: Validator<T>, fallback: () => T): Validator<T> =>
    (value, path) => (value === undefined ? fallback() : inner(value, path));

type Shape = Record<string, Validator<unknown>>;

type Infer<S extends Shape> = { [K in keyof S]: S[K] extends Validator<infer T> ? T : never };

/**
 * Validates an object and rejects unknown keys. Rejecting rather than stripping
 * makes protocol drift loud instead of silent (plan section 8.1).
 */
export const object = <S extends Shape>(shape: S): Validator<Infer<S>> =>
    (value, path) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return fail(path, 'must be an object');
        }
        const source = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(source)) {
            if (!Object.hasOwn(shape, key)) {
                return fail(path === '' ? key : `${path}.${key}`, 'is not a known field');
            }
        }
        for (const [key, validator] of Object.entries(shape)) {
            const childPath = path === '' ? key : `${path}.${key}`;
            const parsed = validator(source[key], childPath);
            if (parsed !== undefined) {
                result[key] = parsed;
            }
        }
        return result as Infer<S>;
    };

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * An opaque, bounded JSON subtree.
 *
 * Stremio stream descriptors are add-on defined, so the service cannot enumerate
 * their fields. It can still bound them: no functions, no cycles, no unbounded
 * nesting, and a hard cap on the serialized size (plan section 11.2).
 */
export const jsonValue = (options: { maxDepth?: number; maxBytes?: number; maxKeys?: number } = {}): Validator<JsonValue> => {
    const { maxDepth = 8, maxBytes = 128 * 1024, maxKeys = 256 } = options;

    const walk = (value: unknown, path: string, depth: number): JsonValue => {
        if (depth > maxDepth) {
            return fail(path, `must not nest deeper than ${maxDepth} levels`);
        }
        if (value === null) {
            return null;
        }
        switch (typeof value) {
            case 'string':
                return value;
            case 'boolean':
                return value;
            case 'number':
                return Number.isFinite(value) ? value : fail(path, 'must be a finite number');
            case 'object':
                break;
            default:
                return fail(path, 'must be JSON-serializable');
        }
        if (Array.isArray(value)) {
            if (value.length > maxKeys) {
                return fail(path, `must contain at most ${maxKeys} items`);
            }
            return value.map((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
        }
        const source = value as Record<string, unknown>;
        const keys = Object.keys(source);
        if (keys.length > maxKeys) {
            return fail(path, `must contain at most ${maxKeys} keys`);
        }
        const out: Record<string, JsonValue> = {};
        for (const key of keys) {
            const entry = source[key];
            if (entry === undefined) {
                continue;
            }
            out[key] = walk(entry, path === '' ? key : `${path}.${key}`, depth + 1);
        }
        return out;
    };

    return (value, path) => {
        const parsed = walk(value, path, 0);
        // Serialized size is what actually travels and what the room stores, so
        // bound that rather than the in-memory shape.
        let serializedLength = 0;
        try {
            serializedLength = JSON.stringify(parsed)?.length ?? 0;
        } catch {
            return fail(path, 'must be JSON-serializable');
        }
        if (serializedLength > maxBytes) {
            return fail(path, `must serialize to at most ${maxBytes} bytes`);
        }
        return parsed;
    };
};
