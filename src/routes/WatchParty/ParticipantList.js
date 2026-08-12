// Copyright (C) 2017-2026 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { useTranslation } = require('react-i18next');
const styles = require('./styles');

// Presence list shared by the join route and the in-player menu.
//
// Two devices signed into the same Stremio account are two participants with the
// same name, so the device label is what tells them apart (plan section 11.4).

const PARTICIPANT_STATUS = {
    OFFLINE: { name: 'offline', translationKey: 'WATCH_PARTY_STATUS_OFFLINE' },
    UNSUPPORTED: { name: 'unsupported', translationKey: 'WATCH_PARTY_STATUS_UNSUPPORTED' },
    BUFFERING: { name: 'buffering', translationKey: 'WATCH_PARTY_STATUS_BUFFERING' },
    READY: { name: 'ready', translationKey: 'WATCH_PARTY_STATUS_READY' },
    LOADING: { name: 'loading', translationKey: 'WATCH_PARTY_STATUS_LOADING' },
};

// Ordered by severity: a disconnected participant is not "buffering", and an
// unsupported one is never "ready".
//
// Buffering outranks ready. The client reports buffering only after a sustained
// active-playback stall, so this state means that playback is genuinely blocked.
const participantStatus = (participant) => {
    if (!participant.connected) {
        return PARTICIPANT_STATUS.OFFLINE;
    }
    if (!participant.supported) {
        return PARTICIPANT_STATUS.UNSUPPORTED;
    }
    if (participant.buffering) {
        return PARTICIPANT_STATUS.BUFFERING;
    }
    if (participant.ready) {
        return PARTICIPANT_STATUS.READY;
    }
    return PARTICIPANT_STATUS.LOADING;
};

const ParticipantList = ({ className, participants, selfParticipantId, onRemoveParticipant }) => {
    const { t } = useTranslation();
    return (
        <ul className={classnames(className, styles['participant-list'])}>
            {
                participants.map((participant) => {
                    const status = participantStatus(participant);
                    return (
                        <li key={participant.participantId} className={styles['participant']}>
                            <div className={styles['participant-identity']}>
                                <div className={styles['participant-primary']}>
                                    <span className={styles['participant-name']}>{participant.displayName}</span>
                                    {
                                        participant.participantId === selfParticipantId ?
                                            <span className={styles['participant-badge']}>{t('WATCH_PARTY_YOU')}</span>
                                            :
                                            null
                                    }
                                    {
                                        participant.isHost ?
                                            <span className={styles['participant-badge']}>{t('WATCH_PARTY_HOST')}</span>
                                            :
                                            null
                                    }
                                </div>
                                {
                                    typeof participant.deviceLabel === 'string' && participant.deviceLabel.length > 0 ?
                                        <span className={styles['participant-device']}>{participant.deviceLabel}</span>
                                        :
                                        null
                                }
                            </div>
                            <div className={styles['participant-actions']}>
                                <span className={classnames(styles['participant-status'], styles[status.name])}>
                                    {t(status.translationKey)}
                                </span>
                                {
                                    typeof onRemoveParticipant === 'function' &&
                                    !participant.isHost &&
                                    participant.participantId !== selfParticipantId ?
                                        <button
                                            type={'button'}
                                            className={styles['participant-remove']}
                                            title={t('WATCH_PARTY_REMOVE_PARTICIPANT')}
                                            aria-label={t('WATCH_PARTY_REMOVE_PARTICIPANT')}
                                            onClick={() => onRemoveParticipant(participant.participantId)}
                                        >
                                            <Icon className={styles['participant-remove-icon']} name={'close'} />
                                        </button>
                                        :
                                        null
                                }
                            </div>
                        </li>
                    );
                })
            }
        </ul>
    );
};

ParticipantList.propTypes = {
    className: PropTypes.string,
    participants: PropTypes.array.isRequired,
    selfParticipantId: PropTypes.string,
    onRemoveParticipant: PropTypes.func,
};

module.exports = ParticipantList;
module.exports.PARTICIPANT_STATUS = PARTICIPANT_STATUS;
module.exports.participantStatus = participantStatus;
