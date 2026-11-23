/**
 * "Get started" checklist on the admin page of a new site: the three things a Jira admin does once (allow access,
 * choose how project admins' changes apply, tell project admins where the app is). Everything else already has safe
 * defaults. Shown until the admin hides it; "Show setup checklist" brings it back.
 *
 * @file        static/app/src/features/admin/SetupCard.jsx
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-23
 * @updated     2026-11-23
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Button } from '../../components/primitives.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { ease } from '../../motion.js';
import { errorText } from '../errors.js';
import { requestConsent } from '../changes/consent.js';

function Step({ n, done, title, text, children }) {
  return (
    <li className={`setup-step ${done ? 'is-done' : ''}`}>
      <span className="setup-step-mark" aria-hidden="true">
        {done ? <Icon name="check" size={16} /> : n}
      </span>
      <div className="stack-8 grow">
        <div className="stack-4">
          <strong>{title}</strong>
          <span className="muted small">{text}</span>
        </div>
        {children && <div className="row-8 wrap">{children}</div>}
      </div>
    </li>
  );
}

export function SetupCard({ initial, onChange }) {
  const { t } = useI18n();
  const notify = useNotify();
  const [setup, setSetup] = useState(initial);
  const [busy, setBusy] = useState(null);
  const [manual, setManual] = useState(false);

  const update = async (step) => {
    setBusy(step);
    try {
      const res = await call('updateSetup', { step });
      setSetup(res.setup);
      onChange?.(res.setup);
      return res.setup;
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const grant = async () => {
    setBusy('access');
    const ok = await requestConsent(t, notify);
    setBusy(null);
    if (ok) setSetup((s) => ({ ...s, access: true }));
  };

  const automatic = async () => {
    setBusy('automatic');
    try {
      await call('setPrivilegedAdmin');
      setSetup((s) => ({ ...s, mode: 'automatic' }));
      notify({ type: 'success', title: t('config.autoSwitchedOn') });
      onChange?.({ ...setup, mode: 'automatic' }, { privilegedChanged: true });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  };

  const announce = async () => {
    const text = t('setup.message');
    try {
      await navigator.clipboard.writeText(text);
      notify({ type: 'success', title: t('setup.copied') });
    } catch {
      // Clipboard blocked in the Jira frame (usual in Forge): show the text in the card, selected, to copy by hand.
      setManual(true);
    }
    await update('announced');
  };

  const complete = setup.access === true && Boolean(setup.mode) && setup.announced;

  return (
    <motion.section
      className="card section setup-card"
      aria-labelledby="sec-setup"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease } }}
    >
      <div className="row-between wrap">
        <div className="stack-4">
          <h2 id="sec-setup" className="h3">
            {complete ? t('setup.titleDone') : t('setup.title')}
          </h2>
          <p className="muted small">{t('setup.hint')}</p>
        </div>
        <Button size="sm" variant={complete ? 'dark' : 'link'} loading={busy === 'dismiss'} onClick={() => update('dismiss')}>
          {complete ? t('setup.done') : t('setup.hide')}
        </Button>
      </div>
      <ol className="setup-steps">
        <Step n={1} done={setup.access === true} title={t('setup.access')} text={setup.access === true ? t('setup.accessDone') : t('setup.accessText')}>
          {setup.access !== true && (
            <Button size="sm" variant="dark" icon="key" loading={busy === 'access'} onClick={grant}>
              {t('changes.grant')}
            </Button>
          )}
        </Step>
        <Step
          n={2}
          done={Boolean(setup.mode)}
          title={t('setup.mode')}
          text={setup.mode === 'automatic' ? t('setup.modeAutomatic') : setup.mode === 'review' ? t('setup.modeReview') : t('setup.modeText')}
        >
          {!setup.mode && (
            <>
              <Button size="sm" variant="dark" icon="check" loading={busy === 'automatic'} disabled={Boolean(busy) || setup.access !== true} onClick={automatic}>
                {t('setup.modeAutomaticButton')}
              </Button>
              <Button size="sm" loading={busy === 'review'} disabled={Boolean(busy)} onClick={() => update('review')}>
                {t('setup.modeReviewButton')}
              </Button>
            </>
          )}
        </Step>
        <Step n={3} done={setup.announced} title={t('setup.announce')} text={setup.announced ? t('setup.announceDone') : t('setup.announceText')}>
          <Button size="sm" variant={setup.announced ? 'secondary' : 'dark'} icon="copy" loading={busy === 'announced'} onClick={announce}>
            {setup.announced ? t('setup.copyAgain') : t('setup.copyMessage')}
          </Button>
          {manual && (
            <label className="field grow setup-manual">
              <span className="field-label">{t('setup.copyManual')}</span>
              <textarea className="input" readOnly rows={4} value={t('setup.message')} ref={(el) => el?.select()} onFocus={(e) => e.target.select()} />
            </label>
          )}
        </Step>
      </ol>
    </motion.section>
  );
}
