import {
  toCents, addAmounts, multiplyAmount, calculateTaxTotals,
} from "./money.js";

function defaultFormatFullName(data) {
  if (!data) return "";
  if (typeof data.displayName === "string" && data.displayName.trim()) return data.displayName.trim();
  if (typeof data.name === "string" && data.name.trim()) return data.name.trim();
  return [data.firstName, data.lastName].filter(Boolean).join(" ").trim();
}

function defaultDescribeSession(session) {
  return `${session.duration || 0} min session`;
}

export function sessionEndDate(session) {
  const start = session?.date?.toDate ? session.date.toDate() : session?.date;
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return null;
  const duration = typeof session.duration === "number" ? session.duration : 0;
  return new Date(start.getTime() + duration * 60 * 1000);
}

export function isCompletedUnbilledSession(session, now = new Date()) {
  if (!session || session.invoiceId) return false;
  const end = sessionEndDate(session);
  return !!end && end < now;
}

export function readInvoiceSessionPricing(session) {
  const explicit = session?.priceMode === "hourly" || session?.priceMode === "flat";
  const mode = explicit ? session.priceMode : "hourly";
  const amount = (typeof session?.priceAmount === "number" && session.priceAmount > 0)
    ? session.priceAmount
    : 0;
  const amountCents = amount
    ? (Number.isInteger(amount) && amount >= 1000 ? amount : toCents(amount))
    : 0;
  return { mode, amountCents };
}

export function isPrivateInvoiceSession(session) {
  const types = Array.isArray(session?.type) ? session.type : [];
  return types.includes("private");
}

export function computeInvoiceLineCents(session) {
  const { mode, amountCents } = readInvoiceSessionPricing(session);
  if (!amountCents) return 0;
  const duration = (typeof session.duration === "number" && session.duration > 0)
    ? session.duration
    : 0;
  if (!duration) return 0;

  const attendeeCount = (typeof session.attendeeCount === "number" && session.attendeeCount > 0)
    ? session.attendeeCount
    : 1;
  const splitBy = isPrivateInvoiceSession(session) ? 1 : attendeeCount;

  if (mode === "flat") return multiplyAmount(amountCents, 1 / splitBy);
  return multiplyAmount(amountCents, (duration / 60) / splitBy);
}

export function buildInvoiceItem(session, lineCents, childLabel = "", options = {}) {
  const { mode, amountCents } = readInvoiceSessionPricing(session);
  const describeSession = options.describeSession || defaultDescribeSession;
  const description = childLabel
    ? `${childLabel} · ${describeSession(session)}`
    : describeSession(session);

  return {
    sessionId: session.id,
    sessionDate: session.date || null,
    iceStart: session.iceStart || null,
    iceEnd: session.iceEnd || null,
    subcoachName: session.subcoachName || null,
    durationMinutes: session.duration || 0,
    priceMode: mode,
    priceAmount: amountCents,
    attendeeCount: session.attendeeCount || 1,
    lineTotal: lineCents,
    description,
  };
}

export function buildInvoiceGroups(sessions, dirs = {}, options = {}) {
  const userDocs = dirs.userDocs || {};
  const childDocs = dirs.childDocs || {};
  const parentDocs = dirs.parentDocs || {};
  const paySettings = options.paySettings || null;
  const formatFullName = options.formatFullName || defaultFormatFullName;
  const buckets = new Map();

  sessions.forEach(session => {
    const participants = Array.isArray(session.participants) ? session.participants : [];
    const children = Array.isArray(session.children) ? session.children : [];

    participants.forEach(uid => {
      if (uid === session.coachUid) return;
      const user = userDocs[uid];
      const roles = user && Array.isArray(user.rolesArray) ? user.rolesArray : [];
      const isSkaterUser = user && (roles.includes("skater") || roles.length === 0);
      const isParentOnly = user && roles.includes("parent") && !roles.includes("skater");
      if (!user || isParentOnly || !isSkaterUser) return;

      const key = `u:${uid}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          key,
          kind: "user",
          skaterId: uid,
          skaterName: formatFullName(user) || "—",
          payerUid: uid,
          payerName: null,
          skaterRef: `users/${uid}`,
          sessions: [],
        });
      }
      buckets.get(key).sessions.push(session);
    });

    children.forEach(childId => {
      const child = childDocs[childId];
      if (!child) return;
      const parent = parentDocs[child.parentId];
      const key = `c:${childId}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          key,
          kind: "child",
          skaterId: childId,
          skaterName: formatFullName(child) || "—",
          payerUid: child.parentId || null,
          payerName: parent ? (formatFullName(parent) || null) : null,
          skaterRef: `children/${childId}`,
          sessions: [],
        });
      }
      buckets.get(key).sessions.push(session);
    });
  });

  const mergedBuckets = mergeChildBucketsByParent(buckets, parentDocs, formatFullName);
  const taxEnabled = !!paySettings?.taxEnabled;
  const gstRate = paySettings ? Number(paySettings.gstRate) || 0 : 0;
  const qstRate = paySettings ? Number(paySettings.qstRate) || 0 : 0;
  const groups = [];

  mergedBuckets.forEach(bucket => {
    bucket.sessions.sort((a, b) => {
      const aTime = a.date?.toDate ? a.date.toDate().getTime() : 0;
      const bTime = b.date?.toDate ? b.date.toDate().getTime() : 0;
      return aTime - bTime;
    });

    const childLabelForSession = (session) => {
      if (bucket.kind !== "parent") return "";
      const names = (Array.isArray(session.children) ? session.children : [])
        .map(childId => childDocs[childId])
        .filter(Boolean)
        .map(child => (formatFullName(child) || "").trim().split(/\s+/)[0] || "—");
      return names.join(", ");
    };

    const items = bucket.sessions.map(session => {
      const lineCents = computeInvoiceLineCents(session);
      return buildInvoiceItem(session, lineCents, childLabelForSession(session), options);
    });
    const subtotalCents = addAmounts(...items.map(item => item.lineTotal));
    const { gstCents, qstCents, totalCents } = calculateTaxTotals(subtotalCents, {
      taxEnabled,
      gstRate,
      qstRate,
    });

    groups.push({
      ...bucket,
      items,
      subtotalCents,
      gstCents,
      qstCents,
      totalCents,
      selected: true,
      expanded: false,
    });
  });

  groups.sort((a, b) => a.skaterName.localeCompare(b.skaterName));
  return groups;
}

function mergeChildBucketsByParent(buckets, parentDocs, formatFullName) {
  const mergedBuckets = new Map();
  const childBucketsByParent = new Map();
  const childKeysToSkip = new Set();

  buckets.forEach(group => {
    if (group.kind === "child" && group.payerUid) {
      if (!childBucketsByParent.has(group.payerUid)) {
        childBucketsByParent.set(group.payerUid, []);
      }
      childBucketsByParent.get(group.payerUid).push(group);
      childKeysToSkip.add(group.key);
    }
  });

  buckets.forEach(group => {
    if (childKeysToSkip.has(group.key)) return;
    if (group.kind === "user" && childBucketsByParent.has(group.skaterId)) return;
    mergedBuckets.set(group.key, group);
  });

  childBucketsByParent.forEach((childGroups, parentUid) => {
    const parent = parentDocs[parentUid];
    const childNames = childGroups.map(group => group.skaterName || "—");
    const childFirstNames = childNames.map(name => (name || "").trim().split(/\s+/)[0] || "—");

    mergedBuckets.set(`p:${parentUid}`, {
      key: `p:${parentUid}`,
      kind: "parent",
      skaterId: parentUid,
      skaterName: parent ? formatFullName(parent) || "—" : "—",
      childFirstNames,
      payerUid: parentUid,
      payerName: null,
      skaterRef: `users/${parentUid}`,
      sessions: childGroups.flatMap(group => group.sessions),
    });
  });

  return mergedBuckets;
}
