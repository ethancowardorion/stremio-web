// Copyright (C) 2017-2026 Smart code 203358507

const WatchPartyProvider = require('./WatchPartyProvider');
const { WatchPartyContext, useWatchParty } = require('./WatchPartyContext');
const protocol = require('./protocol');
const drift = require('./drift');
const mediaIdentity = require('./mediaIdentity');
const { resolveWatchPartyUrl, buildInvitationUrl } = require('./endpoint');
const { CONNECTION_STATUS } = require('./reducer');

module.exports = {
    WatchPartyProvider,
    WatchPartyContext,
    useWatchParty,
    CONNECTION_STATUS,
    PLAYBACK_ACTION: protocol.PLAYBACK_ACTION,
    playerCapabilities: protocol.playerCapabilities,
    isSupportedClient: protocol.isSupportedClient,
    missingCapabilities: protocol.missingCapabilities,
    decideCorrection: drift.decideCorrection,
    expectedPositionMs: drift.expectedPositionMs,
    isSynchronized: drift.isSynchronized,
    DRIFT_REASON: drift.REASON,
    captureSourceBundle: mediaIdentity.captureSourceBundle,
    guestPlayerPath: mediaIdentity.guestPlayerPath,
    mediaDescriptor: mediaIdentity.mediaDescriptor,
    sourceFingerprint: mediaIdentity.sourceFingerprint,
    evaluateSourceCompatibility: mediaIdentity.evaluateSourceCompatibility,
    redactSourceBundle: mediaIdentity.redactSourceBundle,
    SOURCE_COMPATIBILITY: mediaIdentity.COMPATIBILITY,
    resolveWatchPartyUrl,
    buildInvitationUrl,
};
