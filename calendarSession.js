import { toCents, multiplyAmount, formatMoney } from "./money.js";

export function selectedAttendeesFromInputs(inputs = []) {
  const selectedUserUids = [];
  const selectedChildEntries = [];

  inputs.forEach(input => {
    const kind = input.kind || "user";
    if (kind === "child") {
      selectedChildEntries.push({
        id: input.value,
        parentUid: input.parentUid || null,
      });
    } else {
      selectedUserUids.push(input.value);
    }
  });

  const parentUidsFromChildren = Array.from(new Set(
    selectedChildEntries.map(entry => entry.parentUid).filter(Boolean)
  ));
  const childIds = selectedChildEntries.map(entry => entry.id);

  return {
    selectedUserUids,
    selectedChildEntries,
    parentUidsFromChildren,
    childIds,
    attendeeCount: selectedUserUids.length + childIds.length,
  };
}

export function participantUidsForSession(coachUid, selection) {
  return Array.from(new Set([
    coachUid,
    ...selection.selectedUserUids,
    ...selection.parentUidsFromChildren,
  ].filter(Boolean)));
}

export function sessionPriceAmountCents(priceAmount) {
  const amount = Number(priceAmount) || 0;
  if (amount <= 0) return 0;
  return Number.isInteger(amount) && amount >= 1000 ? amount : toCents(amount);
}

export function calendarSessionTotalCents({ priceMode, priceAmount, duration, attendeeCount, isPrivate }) {
  const amountCents = sessionPriceAmountCents(priceAmount);
  if (!amountCents) return 0;
  const count = Math.max(0, Number(attendeeCount) || 0);
  if (!count) return 0;

  const mode = priceMode === "flat" ? "flat" : "hourly";
  const multiplier = isPrivate ? count : 1;
  if (mode === "flat") return multiplyAmount(amountCents, multiplier);

  const minutes = Number(duration) || 0;
  if (minutes <= 0) return 0;
  return multiplyAmount(amountCents, (minutes / 60) * multiplier);
}

export function calendarSessionTotalDisplay(options, locale = "en") {
  const totalCents = calendarSessionTotalCents(options);
  return totalCents > 0 ? formatMoney(totalCents, locale) : "";
}

export function buildSessionWritePayloads(baseSessionData, selection, coachUid) {
  const attendeeCount = Number(selection.attendeeCount) || 0;
  const isPrivate = Array.isArray(baseSessionData.type) && baseSessionData.type.includes("private");

  if (isPrivate && attendeeCount > 1) {
    return [
      ...selection.selectedUserUids.map(uid => ({
        ...baseSessionData,
        participants: Array.from(new Set([coachUid, uid].filter(Boolean))),
        children: [],
        attendeeCount: 1,
        coachUid,
        invoiceId: null,
      })),
      ...selection.selectedChildEntries.map(child => ({
        ...baseSessionData,
        participants: Array.from(new Set([coachUid, child.parentUid].filter(Boolean))),
        children: [child.id],
        attendeeCount: 1,
        coachUid,
        invoiceId: null,
      })),
    ];
  }

  return [{
    ...baseSessionData,
    participants: participantUidsForSession(coachUid, selection),
    children: selection.childIds,
    attendeeCount,
    coachUid,
    invoiceId: null,
  }];
}
