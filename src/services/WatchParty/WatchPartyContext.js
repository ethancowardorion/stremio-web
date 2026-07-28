// Copyright (C) 2017-2026 Smart code 203358507

const React = require('react');

// Null rather than a default value: consuming outside the provider is a wiring
// bug, and `useWatchParty` says so rather than silently returning a no-op object.
const WatchPartyContext = React.createContext(null);

const useWatchParty = () => {
    const context = React.useContext(WatchPartyContext);
    if (context === null) {
        throw new Error('useWatchParty must be used within a WatchPartyProvider');
    }
    return context;
};

module.exports = {
    WatchPartyContext,
    useWatchParty,
};
