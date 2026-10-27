import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Button, Checkbox, IconButton } from '../../components/primitives.jsx';
import { Modal } from '../../components/Modal.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { ease, shake } from '../../motion.js';
import { downloadText } from '../download.js';
import { errorText } from '../errors.js';
import { MIN_PASSPHRASE, decryptExport, encryptExport, readEnvelope } from './exportCrypto.js';

const FORMAT = 'superport-gum-export';
const VERSION = 1;
// Keep each import call well below Forge's payload limits.
const MAX_BYTES = 180_000;

function chunks(list, maxCount) {
  const out = [];
  let current = [];
  let bytes = 0;
  for (const item of list) {
    const size = JSON.stringify(item).length;
    if (current.length && (current.length >= maxCount || bytes + size > MAX_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

// Checks the decrypted content: right format, complete, untouched counts.
function checkExport(data) {
  if (!data || data.format !== FORMAT || data.version !== VERSION || !Array.isArray(data.kvs) || !Array.isArray(data.audit)) return 'transfer.invalidFile';
  if (!data.counts || data.counts.records !== data.kvs.length || data.counts.entries !== data.audit.length) return 'transfer.countMismatch';
  return null;
}

function Progress({ value }) {
  return (
    <div className="transfer-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <motion.span className="transfer-progress-bar" animate={{ width: `${Math.max(2, value * 100)}%` }} transition={{ duration: 0.3, ease }} />
    </div>
  );
}

function PassphraseField({ id, label, value, onChange, autoComplete, invalid, inputRef, disabled }) {
  return (
    <div className="stack-6">
      <label htmlFor={id} className="label-strong">
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        className={`input ${invalid ? 'is-invalid' : ''}`}
        type="password"
        autoComplete={autoComplete}
        spellCheck={false}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Jira admins only: move all app data between installations (e.g. development → production), always encrypted. */
export function DataTransfer({ onImported }) {
  const { t } = useI18n();
  const fileRef = useRef(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [pending, setPending] = useState(null);
  const [fileError, setFileError] = useState(null);

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileError(null);
    try {
      setPending({ name: file.name, envelope: readEnvelope(await file.text()) });
    } catch (err) {
      setFileError(t(err.reason === 'notEncrypted' ? 'transfer.notEncrypted' : 'transfer.invalidFile'));
    }
  };

  return (
    <motion.section className="card section" aria-labelledby="sec-transfer" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease, delay: 0.18 } }}>
      <div className="stack-4">
        <h2 id="sec-transfer" className="h3">
          {t('transfer.title')}
        </h2>
        <p className="muted small">{t('transfer.hint')}</p>
      </div>
      <p className="notice">
        <Icon name="lock" size={16} />
        <span>{t('transfer.security')}</span>
      </p>
      <div className="row-12 wrap">
        <Button icon="download" onClick={() => setExportOpen(true)}>
          {t('transfer.export')}
        </Button>
        <Button icon="clipboard" onClick={() => fileRef.current?.click()}>
          {t('transfer.import')}
        </Button>
        <input ref={fileRef} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={pickFile} />
      </div>
      {fileError && (
        <p className="notice notice-error" role="alert">
          <Icon name="alert" size={16} />
          <span>{fileError}</span>
        </p>
      )}
      <AnimatePresence>{exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}</AnimatePresence>
      <AnimatePresence>
        {pending && (
          <ImportDialog
            file={pending}
            onClose={() => setPending(null)}
            onDone={() => {
              setPending(null);
              onImported?.();
            }}
          />
        )}
      </AnimatePresence>
    </motion.section>
  );
}

function ExportDialog({ onClose }) {
  const { t } = useI18n();
  const notify = useNotify();
  const firstRef = useRef(null);
  const [pass, setPass] = useState('');
  const [repeat, setRepeat] = useState('');
  const [progress, setProgress] = useState(null);
  const [problem, setProblem] = useState(null);
  const [nudge, setNudge] = useState(0);

  const tooShort = [...pass].length < MIN_PASSPHRASE;
  const mismatch = repeat.length > 0 && repeat !== pass;

  const run = async () => {
    if (tooShort || pass !== repeat) {
      setProblem(t(tooShort ? 'transfer.passTooShort' : 'transfer.passMismatch', { min: MIN_PASSPHRASE }));
      setNudge((n) => n + 1);
      return;
    }
    setProblem(null);
    setProgress({ records: 0, entries: 0, step: 'reading' });
    try {
      const meta = await call('exportData', { part: 'meta' });
      const kvs = [];
      const audit = [];
      for (const [part, list] of [
        ['kvs', kvs],
        ['audit', audit],
      ]) {
        let cursor = null;
        do {
          const page = await call('exportData', { part, cursor });
          list.push(...page.entries);
          cursor = page.cursor;
          setProgress({ records: kvs.length, entries: audit.length, step: 'reading' });
        } while (cursor);
      }
      setProgress({ records: kvs.length, entries: audit.length, step: 'encrypting' });
      const text = await encryptExport({ ...meta, counts: { records: kvs.length, entries: audit.length }, kvs, audit }, pass);
      const stamp = new Date(meta.exportedAt).toISOString().slice(0, 10);
      downloadText(text, `group-user-management-export-${stamp}.encrypted.json`, 'application/json');
      notify({ type: 'success', title: t('transfer.exported', { records: kvs.length, entries: audit.length }), description: t('transfer.exportedHint') });
      onClose();
    } catch (err) {
      setProblem(err?.reason ? t('transfer.invalidFile') : errorText(t, err));
      setProgress(null);
    }
  };

  const busy = Boolean(progress);
  return (
    <Modal labelledBy="export-title" onClose={busy ? () => {} : onClose} width={560} initialFocus={firstRef}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <div className="row-between start">
          <div className="stack-6">
            <div className="eyebrow">{t('transfer.encryptedEyebrow')}</div>
            <h1 id="export-title" className="h1">
              {t('transfer.exportTitle')}
            </h1>
          </div>
          <IconButton icon="close" size={20} label={t('create.close')} onClick={onClose} disabled={busy} />
        </div>
        <p className="muted">{t('transfer.exportIntro', { min: MIN_PASSPHRASE })}</p>
        <motion.div className="stack-16" key={nudge} animate={nudge ? shake : undefined}>
          <PassphraseField id="export-pass" label={t('transfer.passphrase')} value={pass} onChange={setPass} autoComplete="new-password" inputRef={firstRef} disabled={busy} invalid={Boolean(problem) && tooShort} />
          <PassphraseField id="export-pass-repeat" label={t('transfer.passphraseRepeat')} value={repeat} onChange={setRepeat} autoComplete="new-password" disabled={busy} invalid={mismatch} />
        </motion.div>
        <p className="notice">
          <Icon name="key" size={16} />
          <span>{t('transfer.keepPassphrase')}</span>
        </p>
        {busy && (
          <p className="muted small" aria-live="polite">
            {progress.step === 'encrypting' ? t('transfer.encrypting') : t('transfer.exporting', { records: progress.records, entries: progress.entries })}
          </p>
        )}
        {problem && (
          <p className="notice notice-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{problem}</span>
          </p>
        )}
        <div className="actions">
          <Button onClick={onClose} disabled={busy}>
            {t('transfer.cancel')}
          </Button>
          <Button type="submit" variant="primary" icon="lock" loading={busy}>
            {t('transfer.exportEncrypted')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ImportDialog({ file, onClose, onDone }) {
  const { t, fmt } = useI18n();
  const notify = useNotify();
  const passRef = useRef(null);
  const [pass, setPass] = useState('');
  const [data, setData] = useState(null);
  const [unlocking, setUnlocking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [progress, setProgress] = useState(null);
  const [problem, setProblem] = useState(null);
  const [nudge, setNudge] = useState(0);
  const total = data ? data.kvs.length + data.audit.length : 0;

  const unlock = async () => {
    setProblem(null);
    setUnlocking(true);
    try {
      const plain = await decryptExport(file.envelope, pass);
      const invalid = checkExport(plain);
      if (invalid) throw Object.assign(new Error(invalid), { key: invalid });
      setPass('');
      setData(plain);
    } catch (err) {
      setProblem(t(err.key ?? (err.reason === 'wrongPassphrase' ? 'transfer.wrongPassphrase' : 'transfer.invalidFile')));
      setNudge((n) => n + 1);
      passRef.current?.focus();
    } finally {
      setUnlocking(false);
    }
  };

  const run = async () => {
    setProblem(null);
    let done = 0;
    let inserted = 0;
    let skipped = 0;
    setProgress({ done });
    try {
      for (const batch of chunks(data.kvs, 100)) {
        await call('importData', { part: 'kvs', entries: batch, cloudId: data.cloudId });
        done += batch.length;
        setProgress({ done });
      }
      for (const batch of chunks(data.audit, 200)) {
        const res = await call('importData', { part: 'audit', entries: batch, cloudId: data.cloudId });
        inserted += res.inserted;
        skipped += res.skipped;
        done += batch.length;
        setProgress({ done });
      }
      await call('importData', { part: 'finish', cloudId: data.cloudId, summary: { records: data.kvs.length, entries: inserted, skipped, exportedAt: data.exportedAt, exportedBy: data.exportedBy } });
      notify({ type: 'success', title: t('transfer.imported', { records: data.kvs.length, entries: inserted, skipped }) });
      onDone();
    } catch (err) {
      setProblem(`${errorText(t, err)} ${t('transfer.failed', { done, total })}`);
      setProgress(null);
    }
  };

  const busy = Boolean(progress) || unlocking;
  return (
    <Modal labelledBy="import-title" onClose={busy ? () => {} : onClose} width={560} initialFocus={passRef}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!data) unlock();
          else if (confirmed) run();
        }}
      >
        <div className="row-between start">
          <div className="stack-6">
            <div className="eyebrow break">{file.name}</div>
            <h1 id="import-title" className="h1">
              {t('transfer.importTitle')}
            </h1>
          </div>
          <IconButton icon="close" size={20} label={t('create.close')} onClick={onClose} disabled={busy} />
        </div>

        {!data ? (
          <>
            <p className="muted">{t('transfer.unlockIntro')}</p>
            <motion.div key={nudge} animate={nudge ? shake : undefined}>
              <PassphraseField id="import-pass" label={t('transfer.passphrase')} value={pass} onChange={setPass} autoComplete="current-password" inputRef={passRef} disabled={unlocking} invalid={Boolean(problem)} />
            </motion.div>
          </>
        ) : (
          <>
            <div className="stack-4">
              <p className="label-strong">{t('transfer.fileCounts', { records: data.kvs.length, entries: data.audit.length })}</p>
              <p className="muted small">{t('transfer.fileInfo', { date: fmt.dateTime(data.exportedAt), name: data.exportedBy ?? '–' })}</p>
            </div>
            <p className="notice">
              <Icon name="info" size={16} />
              <span>{t('transfer.replaceWarning')}</span>
            </p>
            {progress ? (
              <div className="stack-8">
                <Progress value={progress.done / Math.max(1, total)} />
                <p className="muted small" aria-live="polite">
                  {t('transfer.importing', { done: progress.done, total })}
                </p>
              </div>
            ) : (
              <Checkbox id="import-confirm" checked={confirmed} onChange={setConfirmed}>
                {t('transfer.confirm')}
              </Checkbox>
            )}
          </>
        )}

        {problem && (
          <p className="notice notice-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{problem}</span>
          </p>
        )}
        <div className="actions">
          <Button onClick={onClose} disabled={busy}>
            {t('transfer.cancel')}
          </Button>
          {!data ? (
            <Button type="submit" variant="primary" icon="key" loading={unlocking} disabled={!pass}>
              {t('transfer.unlock')}
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={!confirmed} loading={Boolean(progress)}>
              {problem ? t('transfer.retry') : t('transfer.start')}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
