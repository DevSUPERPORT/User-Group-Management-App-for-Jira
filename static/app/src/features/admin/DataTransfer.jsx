import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Button, Checkbox, IconButton } from '../../components/primitives.jsx';
import { Modal } from '../../components/Modal.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { ease } from '../../motion.js';
import { downloadText } from '../download.js';
import { errorText } from '../errors.js';

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

// Checks the file before anything is sent: right format, complete, untouched counts.
function readExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'transfer.invalidFile' };
  }
  if (!data || data.format !== FORMAT || data.version !== VERSION || !Array.isArray(data.kvs) || !Array.isArray(data.audit)) return { error: 'transfer.invalidFile' };
  if (data.counts && (data.counts.records !== data.kvs.length || data.counts.entries !== data.audit.length)) return { error: 'transfer.countMismatch' };
  return { data };
}

function Progress({ value }) {
  return (
    <div className="transfer-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <motion.span className="transfer-progress-bar" animate={{ width: `${Math.max(2, value * 100)}%` }} transition={{ duration: 0.3, ease }} />
    </div>
  );
}

/** Jira admins only: move all app data between installations (e.g. development → production). */
export function DataTransfer({ onImported }) {
  const { t, fmt } = useI18n();
  const notify = useNotify();
  const fileRef = useRef(null);
  const [exporting, setExporting] = useState(null);
  const [pending, setPending] = useState(null);
  const [fileError, setFileError] = useState(null);

  const exportAll = async () => {
    setExporting({ records: 0, entries: 0 });
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
          setExporting({ records: kvs.length, entries: audit.length });
        } while (cursor);
      }
      const file = { ...meta, counts: { records: kvs.length, entries: audit.length }, kvs, audit };
      const stamp = new Date(meta.exportedAt).toISOString().slice(0, 10);
      downloadText(JSON.stringify(file), `group-user-management-export-${stamp}.json`, 'application/json');
      notify({ type: 'success', title: t('transfer.exported', { records: kvs.length, entries: audit.length }) });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setExporting(null);
    }
  };

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileError(null);
    const { data, error } = readExport(await file.text());
    if (error) setFileError(t(error));
    else setPending({ name: file.name, data });
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
        <Icon name="shield" size={16} />
        <span>{t('transfer.adminOnly')}</span>
      </p>
      <div className="row-12 wrap">
        <Button icon="download" onClick={exportAll} loading={Boolean(exporting)}>
          {t('transfer.export')}
        </Button>
        <Button icon="clipboard" onClick={() => fileRef.current?.click()} disabled={Boolean(exporting)}>
          {t('transfer.import')}
        </Button>
        <input ref={fileRef} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={pickFile} />
      </div>
      <AnimatePresence>
        {exporting && (
          <motion.p className="muted small" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {t('transfer.exporting', { records: exporting.records, entries: exporting.entries })}
          </motion.p>
        )}
      </AnimatePresence>
      {fileError && (
        <p className="notice notice-error" role="alert">
          <Icon name="alert" size={16} />
          <span>{fileError}</span>
        </p>
      )}
      <AnimatePresence>
        {pending && (
          <ImportDialog
            file={pending}
            fmt={fmt}
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

function ImportDialog({ file, fmt, onClose, onDone }) {
  const { t } = useI18n();
  const notify = useNotify();
  const { data } = file;
  const [confirmed, setConfirmed] = useState(false);
  const [progress, setProgress] = useState(null);
  const [problem, setProblem] = useState(null);
  const total = data.kvs.length + data.audit.length;

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

  const busy = Boolean(progress);
  return (
    <Modal labelledBy="import-title" onClose={busy ? () => {} : onClose} width={560}>
      <div className="dialog-body">
        <div className="row-between start">
          <div className="stack-6">
            <div className="eyebrow">{file.name}</div>
            <h1 id="import-title" className="h1">
              {t('transfer.importTitle')}
            </h1>
          </div>
          <IconButton icon="close" size={20} label={t('create.close')} onClick={onClose} disabled={busy} />
        </div>
        <div className="stack-4">
          <p className="label-strong">{t('transfer.fileCounts', { records: data.kvs.length, entries: data.audit.length })}</p>
          <p className="muted small">{t('transfer.fileInfo', { date: fmt.dateTime(data.exportedAt), name: data.exportedBy ?? '–' })}</p>
        </div>
        <p className="notice">
          <Icon name="info" size={16} />
          <span>{t('transfer.replaceWarning')}</span>
        </p>
        {busy ? (
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
          <Button variant="primary" onClick={run} disabled={!confirmed} loading={busy}>
            {problem ? t('transfer.retry') : t('transfer.start')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
