import { useEffect, useState } from 'react';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { impactItems, incompleteChecks } from './usageModel.js';

// UC-06 in service of UC-03: what a person loses when removed from the group.
// Uses the (server-side cached) usage of the group.
export function useImpact(groupId) {
  const { t } = useI18n();
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let alive = true;
    setUsage(null);
    call('getUsage', { groupId })
      .then((u) => alive && setUsage(u))
      .catch(() => alive && setUsage(false));
    return () => {
      alive = false;
    };
  }, [groupId]);

  if (usage === null) return { loading: true, items: [], text: t('impact.loading') };
  if (usage === false) return { loading: false, items: [], text: t('impact.unknown') };
  const items = impactItems(t, usage);
  const partial = incompleteChecks(usage).length > 0;
  const base = items.length
    ? t('impact.grants', { list: items.map((i) => `${i.label} (${t(`impact.kind.${i.kind}`)})`).join(', ') })
    : t('impact.none');
  return { loading: false, items, partial, text: partial ? `${base} ${t('impact.partial')}` : base };
}
