// HAND-PORTED (see CHANGES-FROM-UPSTREAM.md). Upstream: src/lib/strategy/in-kind-contribution.ts
// `reviewInKindContribution`, which interleaves these decisions with database reads. This file keeps the
// decisions, in the same order, with the same refusal codes and messages; the facts upstream reads from the
// database are passed in instead. Ownership / authorization checks on the enrollment and the request itself
// (whose account, which session) are server concerns and are not reproduced here.
//
// An in-kind contribution moves tokens the user already holds into a Tax Alpha position WITHOUT selling them,
// so their tax lots (cost basis and acquisition date) move with them. This decides which lots move.
import { effectiveStrategyMinDepositUsd } from "./minimums";

/** USDC (Solana). Never an in-kind asset. */
export const USDC_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface InKindLotElection {
  lotId: string;
  qty: number;
  basisPerUnitUsd: number;
  acquiredAt: number;
}

const MAX_REVIEWED_LOTS = 100;

/** One open tax lot of the contributed asset in the source wallet (upstream `AssetOpenLot`, the fields read here). */
export interface InKindSourceLot {
  displayLotId: string;
  qty: number;
  basisPerUnitUsd: number;
  acquiredAt: number;
  /** Where the lot is held; only "spot" lots can be contributed. */
  location: string;
  /** "unknown" when the acquisition has no recorded cost basis yet. */
  source: string;
  /** True for lots that come from imported (external) tax books. */
  imported?: boolean;
}

export interface InKindContributionFacts {
  amountAtoms: string;
  /** The contributed mint, or null for native SOL. */
  mint: string | null;
  decimals: number;
  strategy: { kind: string; status: string; minDepositUsd: number } | null;
  /** The strategy's current index members. */
  members: { assetId: string; eligible: boolean }[];
  /**
   * The source wallet: must be the user's own Darwin-hosted wallet (upstream compares its stored wallet
   * source to the internal hosted-wallet tag), and not another position's managed wallet.
   */
  sourceWallet: { isUserHostedWallet: boolean; managedByStrategyEnrollmentId: string | null } | null;
  /** The member asset's catalogue entry. */
  asset: { symbol: string; mint: string | null; decimals: number } | null;
  /** A fresh decision price for the asset, USD. */
  priceUsd: number | null;
  /** The user's standing lot-disposal method. */
  method: "FIFO" | "LIFO" | string;
  /** Open lots of the asset in the source wallet, and each lot's quantity still available to move. */
  openLots: InKindSourceLot[];
  availableQtyById: ReadonlyMap<string, number>;
  preferredLotId?: string;
  selectedLotIds?: string[];
  reviewedLots?: InKindLotElection[];
}

export type InKindReview =
  | { ok: true; assetId: string; symbol: string; mint: string; decimals: number; priceUsd: number; qty: number; minUsd: number; lots: InKindLotElection[]; sourceLots: InKindSourceLot[] }
  | { ok: false; status: number; code: string; error: string; sourceLots?: InKindSourceLot[] };

export function reviewInKindContributionFacts(f: InKindContributionFacts): InKindReview {
  const fail = (status: number, code: string, error: string): InKindReview => ({ ok: false, status, code, error });
  if (!/^\d+$/.test(f.amountAtoms) || BigInt(f.amountAtoms) <= 0n) return fail(400, "invalid_amount", "Enter an amount to contribute.");
  if (f.mint === USDC_MINT_ADDRESS) {
    return fail(400, "strategy_not_eligible", "In-kind contributions are available for live single-asset crypto strategies only.");
  }
  const strat = f.strategy;
  if (strat?.kind !== "crypto-single-asset-tlh" || strat.status !== "live" || f.members.length !== 1 || !f.members[0]!.eligible) {
    return fail(400, "strategy_not_eligible", "In-kind contributions are available for live single-asset crypto strategies only.");
  }
  if (!f.sourceWallet || !f.sourceWallet.isUserHostedWallet || f.sourceWallet.managedByStrategyEnrollmentId) {
    return fail(403, "source_not_eligible", "Select your linked hosted account.");
  }
  const assetId = f.members[0]!.assetId;
  if (assetId === "solana" && f.mint === null) {
    return fail(400, "wrapped_sol_required", "Wrap SOL before contributing it in kind to this strategy.");
  }
  if (!f.asset?.mint || f.asset.mint !== f.mint || f.asset.decimals !== f.decimals) {
    return fail(400, "asset_mismatch", "This asset does not match the selected strategy.");
  }
  const priceUsd = f.priceUsd;
  if (!(priceUsd && priceUsd > 0)) {
    return fail(503, "price_unavailable", "A fresh asset price is required before contributing in kind.");
  }
  const qty = Number(BigInt(f.amountAtoms)) / 10 ** f.decimals;
  const minUsd = effectiveStrategyMinDepositUsd(strat.kind, Number(strat.minDepositUsd));
  if (!Number.isFinite(qty) || qty <= 0 || qty * priceUsd + 1e-9 < minUsd) {
    return fail(400, "strategy_min_deposit", `Contribute at least $${minUsd} of ${f.asset.symbol}.`);
  }
  const sourceLots = f.openLots.filter((l) => l.location === "spot")
    .map((l) => ({ ...l, qty: l.source === "unknown" ? l.qty : Math.min(l.qty, f.availableQtyById.get(l.displayLotId) ?? 0) }))
    .filter((l) => l.qty > 1e-12);
  const ordered = [...sourceLots].sort((a, b) => f.method === "FIFO"
    ? a.acquiredAt - b.acquiredAt
    : f.method === "LIFO"
      ? b.acquiredAt - a.acquiredAt
      : b.basisPerUnitUsd - a.basisPerUnitUsd || a.acquiredAt - b.acquiredAt);
  if (f.preferredLotId) {
    const preferred = ordered.findIndex((l) => l.displayLotId === f.preferredLotId);
    if (preferred < 0) return fail(409, "bought_lot_unavailable", "The newly bought lot is not available yet. Try again after its tax record updates.");
    ordered.unshift(ordered.splice(preferred, 1)[0]!);
  }
  if (f.selectedLotIds) {
    const selectedIds = new Set(f.selectedLotIds);
    if (f.preferredLotId && !selectedIds.has(f.preferredLotId)) {
      return fail(409, "bought_lot_required", "The newly bought lot must be included in this Tax Alpha contribution.");
    }
    if (selectedIds.size !== f.selectedLotIds.length || f.selectedLotIds.some((id) => !ordered.some((lot) => lot.displayLotId === id))) {
      return fail(409, "lots_changed", "The tax lots changed. Review and confirm them again.");
    }
    ordered.splice(0, ordered.length, ...f.selectedLotIds.map((id) => sourceLots.find((lot) => lot.displayLotId === id)!));
  }
  if (f.reviewedLots) {
    if (f.reviewedLots.length > MAX_REVIEWED_LOTS) return fail(400, "too_many_lots", "This contribution spans more than 100 tax lots. Contribute a smaller amount at a time.");
    const byId = new Map(sourceLots.map((l) => [l.displayLotId, l]));
    const seen = new Set<string>();
    let total = 0;
    for (const reviewed of f.reviewedLots) {
      const actual = byId.get(reviewed.lotId);
      if (!actual || seen.has(reviewed.lotId) || !Number.isFinite(reviewed.qty) || reviewed.qty <= 0 ||
          reviewed.qty > actual.qty + 1e-9 || reviewed.basisPerUnitUsd !== actual.basisPerUnitUsd ||
          reviewed.acquiredAt !== actual.acquiredAt || actual.source === "unknown" || actual.imported) {
        return fail(409, "lots_changed", "The tax lots changed. Review and confirm them again.");
      }
      seen.add(reviewed.lotId);
      total += reviewed.qty;
    }
    if (Math.abs(total - qty) > Math.max(1e-9, qty * 1e-9)) return fail(409, "lots_changed", "The tax lots changed. Review and confirm them again.");
    return { ok: true, assetId, symbol: f.asset.symbol, mint: f.mint ?? "", decimals: f.decimals, priceUsd, qty, minUsd, lots: f.reviewedLots, sourceLots };
  }
  const selected: InKindLotElection[] = [];
  let need = qty;
  for (const lot of ordered) {
    if (need <= 1e-10) break;
    const take = Math.min(need, lot.qty);
    if (take <= 0) continue;
    if (lot.imported) return { ok: false, status: 409, code: "imported_lot_transfer_unavailable", error: "This tax lot cannot yet be contributed in kind. Select another lot, or invest USD.", sourceLots };
    if (lot.source === "unknown" || !Number.isFinite(lot.basisPerUnitUsd)) {
      return { ok: false, status: 409, code: "basis_reconciliation_required", error: "Enter the per-unit basis for every selected lot before contributing.", sourceLots };
    }
    selected.push({ lotId: lot.displayLotId, qty: take, basisPerUnitUsd: lot.basisPerUnitUsd, acquiredAt: lot.acquiredAt });
    need -= take;
  }
  if (need > Math.max(1e-9, qty * 1e-9)) return fail(409, "insufficient_lots", "The sub-account's verified tax lots do not cover this contribution. Reconcile its holdings first.");
  if (f.selectedLotIds && selected.length !== f.selectedLotIds.length) {
    return { ok: false, status: 409, code: "selection_exceeds_amount", error: "One or more selected lots would not be used. Uncheck the extra lots or increase the contribution amount.", sourceLots };
  }
  if (selected.length > MAX_REVIEWED_LOTS) return fail(400, "too_many_lots", "This contribution spans more than 100 tax lots. Contribute a smaller amount at a time.");
  return { ok: true, assetId, symbol: f.asset.symbol, mint: f.mint ?? "", decimals: f.decimals, priceUsd, qty, minUsd, lots: selected, sourceLots };
}
