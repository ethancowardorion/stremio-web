// Copyright (C) 2017-2026 Smart code 203358507

const React = require('react');
const classnames = require('classnames');
const { useParams, useNavigate } = require('react-router');
const { useSearchParams } = require('react-router-dom');
const { useTranslation } = require('react-i18next');
const { HorizontalNavBar, Button, TextInput } = require('stremio/components');
const { useWatchParty, guestPlayerPath } = require('stremio/services/WatchParty');
const ParticipantList = require('./ParticipantList');
const { errorTranslationKey, closeReasonTranslationKey } = require('./errorMessage');
const styles = require('./styles');

// Invitation route.
//
// Joins the room, shows who is already there, and hands the guest off to the
// normal Stremio player route rebuilt from the host's raw source context. The
// guest's own streaming server resolves the stream, so a host-local runtime URL
// is never reused (plan section 11.3).

const PHASE = {
    IDLE: 'idle',
    JOINING: 'joining',
    JOINED: 'joined',
    FAILED: 'failed',
};

const WatchParty = () => {
    const { roomId } = useParams();
    const [queryParams] = useSearchParams();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const watchParty = useWatchParty();

    const [phase, setPhase] = React.useState(PHASE.IDLE);
    const [failure, setFailure] = React.useState(null);
    const [displayName, setDisplayName] = React.useState(watchParty.displayName);
    const [deviceLabel, setDeviceLabel] = React.useState('');

    React.useEffect(() => {
        setDisplayName(watchParty.displayName);
    }, [watchParty.displayName]);

    // The invitation secret travels in the query string. It is also kept for the
    // tab so a reload does not require the original link.
    const inviteSecret = React.useMemo(() => {
        const fromQuery = queryParams.get('invite');
        if (typeof fromQuery === 'string' && fromQuery.length > 0) {
            return fromQuery;
        }
        return null;
    }, [queryParams]);

    const alreadyInThisRoom = watchParty.room !== null && watchParty.room.roomId === roomId;

    const playerPath = React.useMemo(() => {
        if (!alreadyInThisRoom) {
            return null;
        }
        return guestPlayerPath(watchParty.source, watchParty.media);
    }, [alreadyInThisRoom, watchParty.source, watchParty.media]);

    const openPlayer = React.useCallback(() => {
        if (playerPath !== null) {
            navigate(playerPath);
        }
    }, [navigate, playerPath]);

    const onJoin = React.useCallback(() => {
        if (typeof roomId !== 'string' || inviteSecret === null) {
            setFailure({ code: 'INVALID_INVITATION' });
            setPhase(PHASE.FAILED);
            return;
        }
        setFailure(null);
        setPhase(PHASE.JOINING);
        watchParty.actions.setDisplayName(displayName);
        watchParty.actions
            .joinRoom({
                roomId,
                inviteSecret,
                displayName,
                deviceLabel: deviceLabel.trim().length > 0 ? deviceLabel.trim() : null,
            })
            .then((payload) => {
                setPhase(PHASE.JOINED);
                const path = guestPlayerPath(payload.room ? payload.room.source : null, payload.room ? payload.room.media : null);
                if (path !== null) {
                    // The join click is the user gesture the browser needs, so the
                    // handoff happens immediately rather than behind another step.
                    navigate(path);
                }
            })
            .catch((error) => {
                setFailure(error);
                setPhase(PHASE.FAILED);
            });
    }, [roomId, inviteSecret, displayName, deviceLabel, watchParty.actions, navigate]);

    const onLeave = React.useCallback(() => {
        watchParty.actions.leave();
        setPhase(PHASE.IDLE);
    }, [watchParty.actions]);

    const failureKey = React.useMemo(() => {
        if (failure === null) {
            return null;
        }
        if (failure.code === 'INVALID_INVITATION') {
            return 'WATCH_PARTY_ERROR_INVALID_INVITATION';
        }
        return errorTranslationKey(failure);
    }, [failure]);

    const closeKey = React.useMemo(
        () => (alreadyInThisRoom ? null : closeReasonTranslationKey(watchParty.closeReason)),
        [alreadyInThisRoom, watchParty.closeReason]
    );

    const joinDisabled = phase === PHASE.JOINING || inviteSecret === null || displayName.trim().length === 0;

    return (
        <div className={styles['watch-party-container']}>
            <HorizontalNavBar
                className={styles['nav-bar']}
                title={t('WATCH_PARTY_JOIN_TITLE')}
                backButton={true}
                fullscreenButton={true}
            />
            <div className={styles['watch-party-content']}>
                {
                    !watchParty.available ?
                        <div className={styles['notice']}>{t('WATCH_PARTY_UNAVAILABLE')}</div>
                        :
                        null
                }
                {
                    watchParty.available && inviteSecret === null && !alreadyInThisRoom ?
                        <div className={styles['notice']}>{t('WATCH_PARTY_ERROR_INVALID_INVITATION')}</div>
                        :
                        null
                }
                {
                    closeKey !== null ?
                        <div className={styles['notice']}>{t(closeKey)}</div>
                        :
                        null
                }
                {
                    failureKey !== null ?
                        <div className={classnames(styles['notice'], styles['notice-error'])}>{t(failureKey)}</div>
                        :
                        null
                }

                {
                    alreadyInThisRoom ?
                        <div className={styles['room-panel']}>
                            <div className={styles['section-label']}>{t('WATCH_PARTY_NOW_PLAYING')}</div>
                            <div className={styles['media-title']}>
                                {watchParty.media !== null && typeof watchParty.media.title === 'string' ? watchParty.media.title : ''}
                            </div>
                            <div className={styles['section-label']}>{t('WATCH_PARTY_PARTICIPANTS')}</div>
                            <ParticipantList
                                participants={watchParty.participants}
                                selfParticipantId={watchParty.selfParticipantId}
                            />
                            {
                                watchParty.session !== null && !watchParty.session.supported ?
                                    <div className={styles['notice']}>{t('WATCH_PARTY_UNSUPPORTED_PLAYER')}</div>
                                    :
                                    null
                            }
                            <div className={styles['actions']}>
                                <Button
                                    className={classnames(styles['action-button'], { 'disabled': playerPath === null })}
                                    onClick={openPlayer}
                                >
                                    <div className={styles['action-label']}>{t('WATCH_PARTY_OPEN_PLAYER')}</div>
                                </Button>
                                <Button className={classnames(styles['action-button'], styles['secondary'])} onClick={onLeave}>
                                    <div className={styles['action-label']}>{t('WATCH_PARTY_LEAVE')}</div>
                                </Button>
                            </div>
                        </div>
                        :
                        <div className={styles['join-panel']}>
                            <label className={styles['field']}>
                                <span className={styles['field-label']}>{t('WATCH_PARTY_DISPLAY_NAME')}</span>
                                <TextInput
                                    className={styles['field-input']}
                                    value={displayName}
                                    placeholder={t('WATCH_PARTY_DISPLAY_NAME_PLACEHOLDER')}
                                    maxLength={48}
                                    disabled={phase === PHASE.JOINING}
                                    onChange={(event) => setDisplayName(event.target.value)}
                                    onSubmit={onJoin}
                                />
                            </label>
                            <label className={styles['field']}>
                                <span className={styles['field-label']}>{t('WATCH_PARTY_DEVICE_LABEL')}</span>
                                <TextInput
                                    className={styles['field-input']}
                                    value={deviceLabel}
                                    placeholder={t('WATCH_PARTY_DEVICE_LABEL_PLACEHOLDER')}
                                    maxLength={48}
                                    disabled={phase === PHASE.JOINING}
                                    onChange={(event) => setDeviceLabel(event.target.value)}
                                    onSubmit={onJoin}
                                />
                            </label>
                            <div className={styles['actions']}>
                                <Button
                                    className={classnames(styles['action-button'], { 'disabled': joinDisabled })}
                                    disabled={joinDisabled}
                                    onClick={onJoin}
                                >
                                    <div className={styles['action-label']}>
                                        {phase === PHASE.JOINING ? t('WATCH_PARTY_JOINING') : t('WATCH_PARTY_JOIN')}
                                    </div>
                                </Button>
                                {
                                    phase === PHASE.FAILED ?
                                        <Button
                                            className={classnames(styles['action-button'], styles['secondary'])}
                                            onClick={watchParty.actions.retryConnection}
                                        >
                                            <div className={styles['action-label']}>{t('WATCH_PARTY_RETRY')}</div>
                                        </Button>
                                        :
                                        null
                                }
                            </div>
                        </div>
                }
            </div>
        </div>
    );
};

module.exports = WatchParty;
