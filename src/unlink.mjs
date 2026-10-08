// Who may be unlinked, and when a run refuses to unlink at all.
//
// A company that stops resolving is cleared (see "A company that drops out" in docs/SPEC.md).
// Clearing is destructive, so it only happens when this run could have seen the link that is
// now missing, and never in bulk by accident:
//
// Holds (the company is left untouched and listed as held):
//   - it was linked by a mapping row and this run has no --mapping            (always)
//   - it was linked by usage and this run has no usage source (--usage or --usage-sql) (always)
//   - this state folder has no record of how it was linked                   (unless --allow-unlink)
//   - the Stripe account cannot be identified, or is not the one recorded    (unless --allow-unlink)
//     (for a warehouse source the identity is the billing query, see docs/SPEC.md)
// Guard (sync refuses, nothing written, unless --allow-unlink):
//   - Stripe returned no customers while companies are linked, or
//   - more than GUARD_MIN companies AND more than GUARD_SHARE of linked companies would unlink.

export const GUARD_SHARE = 0.1;
export const GUARD_MIN = 2;

const blank = (v) => v === null || v === undefined || String(v).trim() === '';

function holdFor(u, { snapshot, provided, stripeAccount, allowUnlink }) {
  const links = snapshot?.links?.[u.hubspot_company_id];
  if (links?.includes('mapping') && !provided.mapping) return 'it was linked by a mapping row and this run has no --mapping';
  if (links?.includes('usage') && !provided.usage) return 'it was linked by usage and this run has no usage source (--usage or --usage-sql)';
  if (allowUnlink) return null;
  if (!links) return 'there is no record in this state folder of how it was linked (pass --allow-unlink to clear it anyway)';
  if (!stripeAccount?.id) return `the Stripe account could not be identified (${stripeAccount?.reason ?? 'unknown'}), so a missing customer cannot be told from a different account (pass --allow-unlink to clear it anyway)`;
  if (snapshot?.stripe_account && snapshot.stripe_account !== stripeAccount.id) {
    return `this run reads ${stripeAccount.label ?? 'Stripe account'} ${stripeAccount.id}, but this state folder was synced from ${snapshot.stripe_account} (pass --allow-unlink if that is intended)`;
  }
  return null;
}

export function applyUnlinkPolicy({ model, current, snapshot, provided, stripeAccount, allowUnlink = false, customersCount }) {
  const unlinked = (model.unlinked ?? []).map((u) => ({ ...u, held: u.cleared ? null : holdFor(u, { snapshot, provided, stripeAccount, allowUnlink }) }));
  const linked = [...current.values()].filter((p) => !blank(p.rs_billing_status) && p.rs_billing_status !== 'unlinked').length;
  const would = unlinked.filter((u) => !u.cleared && !u.held).length;
  let reason = null;
  if (would > 0 && customersCount === 0 && linked > 0) reason = `Stripe returned no customers, but ${linked} companies are linked`;
  else if (would > GUARD_MIN && would > GUARD_SHARE * linked) reason = `${would} of ${linked} linked companies (${Math.round((would / linked) * 100)}%) would be unlinked in one run`;
  const guard = !reason
    ? { ok: true, linked, would_unlink: would, reason: null }
    : allowUnlink
      ? { ok: true, linked, would_unlink: would, reason: `${reason}; proceeding because --allow-unlink was passed` }
      : { ok: false, linked, would_unlink: would, reason };
  return { ...model, unlinked, unlink_guard: guard };
}
