import { buildInvoiceGroups, isCompletedUnbilledSession } from "./invoiceTotals.js";

export function buildDashboardUnbilledSummary(sessions, dirs = {}, options = {}) {
  const now = options.now || new Date();
  const completed = sessions.filter(session => isCompletedUnbilledSession(session, now));
  const groups = buildInvoiceGroups(completed, dirs, {
    paySettings: options.paySettings || null,
    formatFullName: options.formatFullName,
    describeSession: options.describeSession,
  });

  return {
    groups,
    sessionCount: groups.reduce((count, group) => count + group.items.length, 0),
    subtotalCents: groups.reduce((total, group) => total + group.subtotalCents, 0),
    gstCents: groups.reduce((total, group) => total + group.gstCents, 0),
    qstCents: groups.reduce((total, group) => total + group.qstCents, 0),
    totalCents: groups.reduce((total, group) => total + group.totalCents, 0),
  };
}
