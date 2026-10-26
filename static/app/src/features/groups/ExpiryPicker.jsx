import { useId } from 'react';
import { useI18n } from '../../i18n/index.jsx';

const DAY = 24 * 60 * 60 * 1000;
const PRESETS = [7, 30, 90];

// End of the given local day, so "until 30.11." includes the whole 30th.
function endOfDay(ts) {
  const d = new Date(ts);
  d.setHours(23, 59, 0, 0);
  return d.getTime();
}

const toDateInput = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** value: { mode: 'none' | '7' | '30' | '90' | 'date', date: 'YYYY-MM-DD' } */
export function expiryFromValue(value) {
  if (!value || value.mode === 'none') return null;
  if (value.mode === 'date') {
    if (!value.date) return null;
    const [y, m, d] = value.date.split('-').map(Number);
    return endOfDay(new Date(y, m - 1, d).getTime());
  }
  return endOfDay(Date.now() + Number(value.mode) * DAY);
}

export function valueFromExpiry(ts) {
  return ts ? { mode: 'date', date: toDateInput(ts) } : { mode: 'none', date: '' };
}

export const NO_EXPIRY = { mode: 'none', date: '' };

export function ExpiryPicker({ value, onChange, label, compact = false }) {
  const { t } = useI18n();
  const id = useId();
  const tomorrow = toDateInput(Date.now() + DAY);
  const max = toDateInput(Date.now() + 729 * DAY);
  return (
    <div className={`field expiry-picker ${compact ? 'is-compact' : ''}`}>
      <label htmlFor={`${id}-mode`} className="field-label">
        {label ?? t('expiry.label')}
      </label>
      <div className="expiry-row">
        <select id={`${id}-mode`} className="input" value={value.mode} onChange={(e) => onChange({ mode: e.target.value, date: value.date || tomorrow })}>
          <option value="none">{t('expiry.none')}</option>
          {PRESETS.map((d) => (
            <option key={d} value={String(d)}>
              {t('expiry.days', { count: d })}
            </option>
          ))}
          <option value="date">{t('expiry.date')}</option>
        </select>
        {value.mode === 'date' && (
          <input
            className="input input-date"
            type="date"
            aria-label={t('expiry.dateLabel')}
            min={tomorrow}
            max={max}
            value={value.date}
            onChange={(e) => onChange({ ...value, date: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}
