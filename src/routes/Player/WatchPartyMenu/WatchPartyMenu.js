// Copyright (C) 2017-2026 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { useTranslation } = require('react-i18next');
const { Button, TextInput } = require('stremio/components');
const { CONNECTION_STATUS, SOURCE_COMPATIBILITY } = require('stremio/services/WatchParty');
const ParticipantList = require('stremio/routes/WatchParty/ParticipantList');
const { errorTranslationKey } = require('stremio/routes/WatchParty/errorMessage');
const styles = require('./styles');

// In-player watch party panel.
//
// Everything a participant needs while watching: who is in the room, whether
// they are ready, the invitation to share, and the single button that satisfies
// the browser's media-activation requirement.

const CONNECTION_TRANSLATION_KEYS = {
    [CONNECTION_STATUS.IDLE]: 'WATCH_PARTY_DISCONNECTED',
    [CONNECTION_STATUS.CONNECTING]: 'WATCH_PARTY_CONNECTING',
    [CONNECTION_STATUS.CONNECTED]: 'WATCH_PARTY_CONNECTED',
    [CONNECTION_STATUS.RECONNECTING]: 'WATCH_PARTY_RECONNECTING',
    [CONNECTION_STATUS.CLOSED]: 'WATCH_PARTY_DISCONNECTED',
};

const SOURCE_TRANSLATION_KEYS = {
    [SOURCE_COMPATIBILITY.FINGERPRINT_MISMATCH]: 'WATCH_PARTY_SOURCE_MISMATCH',
    [SOURCE_COMPATIBILITY.DURATION_MISMATCH]: 'WATCH_PARTY_DURATION_MISMATCH',
};

const WatchPartyMenu = ({ className, watchParty, casting, onMouseDown }) => {
    const { t } = useTranslation();
    const [creating, setCreating] = React.useState(false);
    const [copied, setCopied] = React.useState(false);
    const [failure, setFailure] = React.useState(null);

    const onStart = React.useCallback(() => {
        setFailure(null);
        setCreating(true);
        watchParty.startParty({})
            .catch((error) => setFailure(error))
            .then(() => setCreating(false));
    }, [watchParty.startParty]);

    const onCopy = React.useCallback(() => {
        if (watchParty.invitationUrl === null) {
            return;
        }
        // Clipboard access can be denied; the input below still lets the host
        // select and copy the invitation by hand.
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
        if (clipboard && typeof clipboard.writeText === 'function') {
            clipboard.writeText(watchParty.invitationUrl).then(
                () => setCopied(true),
                () => setCopied(false)
            );
        }
    }, [watchParty.invitationUrl]);

    const sourceKey = SOURCE_TRANSLATION_KEYS[watchParty.sourceCompatibility.status] || null;
    const failureKey = failure === null ? null : errorTranslationKey(failure);
    const connectionKey = CONNECTION_TRANSLATION_KEYS[watchParty.status] || 'WATCH_PARTY_DISCONNECTED';

    return (
        <div className={classnames(className, styles['watch-party-menu-container'])} onMouseDown={onMouseDown}>
            <div className={styles['header']}>
                <span className={styles['title']}>{t('WATCH_PARTY')}</span>
                <span className={styles['connection']}>{t(connectionKey)}</span>
            </div>

            {
                !watchParty.available ?
                    <div className={styles['notice']}>{t('WATCH_PARTY_UNAVAILABLE')}</div>
                    :
                    null
            }
            {
                failureKey !== null ?
                    <div className={classnames(styles['notice'], styles['error'])}>{t(failureKey)}</div>
                    :
                    null
            }

            {
                !watchParty.inRoom ?
                    <div className={styles['section']}>
                        {
                            casting ?
                                <div className={styles['notice']}>{t('WATCH_PARTY_CASTING_BLOCKED')}</div>
                                :
                                null
                        }
                        <Button
                            className={classnames(styles['action-button'], { 'disabled': creating || casting || !watchParty.available })}
                            disabled={creating || casting || !watchParty.available}
                            onClick={onStart}
                        >
                            <div className={styles['action-label']}>
                                {creating ? t('WATCH_PARTY_CREATING') : t('WATCH_PARTY_CREATE')}
                            </div>
                        </Button>
                    </div>
                    :
                    <React.Fragment>
                        {
                            watchParty.isHost && watchParty.invitationUrl !== null ?
                                <div className={styles['section']}>
                                    <span className={styles['section-label']}>{t('WATCH_PARTY_COPY_INVITATION')}</span>
                                    <TextInput
                                        className={styles['invitation-input']}
                                        value={watchParty.invitationUrl}
                                        readOnly={true}
                                        onFocus={(event) => event.target.select()}
                                    />
                                    <Button className={styles['action-button']} onClick={onCopy}>
                                        <div className={styles['action-label']}>
                                            {copied ? t('WATCH_PARTY_COPIED') : t('WATCH_PARTY_COPY_INVITATION')}
                                        </div>
                                    </Button>
                                </div>
                                :
                                null
                        }

                        <div className={styles['section']}>
                            <span className={styles['section-label']}>{t('WATCH_PARTY_PARTICIPANTS')}</span>
                            <ParticipantList
                                participants={watchParty.participants}
                                selfParticipantId={watchParty.self === null ? null : watchParty.self.participantId}
                            />
                        </div>

                        {
                            !watchParty.supported ?
                                <div className={styles['notice']}>{t('WATCH_PARTY_UNSUPPORTED_PLAYER')}</div>
                                :
                                null
                        }
                        {
                            sourceKey !== null ?
                                <div className={classnames(styles['notice'], styles['error'])}>{t(sourceKey)}</div>
                                :
                                null
                        }
                        {
                            watchParty.isFollower && !watchParty.ready ?
                                <div className={styles['notice']}>{t('WATCH_PARTY_WAITING_FOR_HOST')}</div>
                                :
                                null
                        }
                        {
                            watchParty.isFollower ?
                                <div className={styles['notice']}>{t('WATCH_PARTY_CONTROLS_LOCKED')}</div>
                                :
                                null
                        }

                        <div className={styles['section']}>
                            {
                                !watchParty.activated || watchParty.activationRequired ?
                                    <Button className={styles['action-button']} onClick={watchParty.markReady}>
                                        <div className={styles['action-label']}>{t('WATCH_PARTY_ACTIVATE')}</div>
                                    </Button>
                                    :
                                    null
                            }
                            {
                                watchParty.isHost ?
                                    <Button className={styles['action-button']} onClick={watchParty.refreshSource}>
                                        <div className={styles['action-label']}>{t('WATCH_PARTY_REFRESH_SOURCE')}</div>
                                    </Button>
                                    :
                                    null
                            }
                            <Button
                                className={classnames(styles['action-button'], styles['secondary'])}
                                onClick={watchParty.isHost ? watchParty.closeRoom : watchParty.leave}
                            >
                                <div className={styles['action-label']}>
                                    {watchParty.isHost ? t('WATCH_PARTY_END') : t('WATCH_PARTY_LEAVE')}
                                </div>
                            </Button>
                        </div>
                    </React.Fragment>
            }
        </div>
    );
};

WatchPartyMenu.propTypes = {
    className: PropTypes.string,
    watchParty: PropTypes.object.isRequired,
    casting: PropTypes.bool,
    onMouseDown: PropTypes.func,
};

module.exports = WatchPartyMenu;
