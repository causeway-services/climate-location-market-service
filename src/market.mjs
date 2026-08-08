import { EMPTY_WITNESS_ROOT, identifyJsonSemanticContent } from "@red-cup-engineering/semantic-content-identify-service";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSettlementStore, querySettlementRecords, recordSettlementRecord } from "@red-cup-engineering/witness-journal-rdf-projection-service/client";

export const NODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ACTOR = "urn:ame:climate-location-market-enterprise";
export const CHANNEL = "urn:ame:climate-youtube-channel-enterprise";
const UNIT = "USD-micros";
export function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
export function digest(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
export function contentId(value) { return identifyJsonSemanticContent({ objectKind: "emsweb.climate-location-market.record", value: value, witnessRoot: EMPTY_WITNESS_ROOT }).token; }
function exactId(value) { if (!value || typeof value !== "object") return false; const { id, ...body } = value; return id === contentId(body); }

export function placeIdentity({ name, countryCode, admin1Code, latitudeE6, longitudeE6, timezone, geocoderAdmission } = {}) {
  if (typeof name !== "string" || name.trim() === "" || !/^[A-Z]{2}$/u.test(countryCode ?? "") || typeof admin1Code !== "string" || admin1Code.trim() === "") throw new TypeError("place requires name, country code, and first-order administration");
  if (!Number.isInteger(latitudeE6) || latitudeE6 < -90000000 || latitudeE6 > 90000000 || !Number.isInteger(longitudeE6) || longitudeE6 < -180000000 || longitudeE6 > 180000000) throw new TypeError("place coordinates must be integer microdegrees");
  if (typeof timezone !== "string" || timezone.trim() === "" || typeof geocoderAdmission !== "string" || geocoderAdmission.trim() === "") throw new TypeError("place requires timezone and geocoder admission");
  const body = { type: "GeoPlaceIdentity", name, countryCode, admin1Code, latitudeE6, longitudeE6, timezone, geocoderAdmission };
  return { id: contentId(body), ...body };
}

export function demandBid({ bidder, civilDay, place, maxValueMicros, paymentCommitment, offeredAt } = {}) {
  if (!exactId(place) || place.type !== "GeoPlaceIdentity") throw new TypeError("demand bid requires a content-valid place");
  if (typeof bidder !== "string" || bidder.trim() === "" || !/^\d{4}-\d{2}-\d{2}$/u.test(civilDay ?? "") || !Number.isSafeInteger(maxValueMicros) || maxValueMicros <= 0 || typeof paymentCommitment !== "string" || paymentCommitment.trim() === "") throw new TypeError("demand bid requires bidder, day, positive safe value, and payment commitment");
  const object = { type: "ClimateLocationDemandBid", civilDay, place, accountingUnit: UNIT, maxValueMicros, paymentCommitment };
  const body = { type: "Offer", actor: bidder, target: ACTOR, object, published: offeredAt };
  return { id: contentId(body), ...body };
}

export function researchOffer({ supplier, civilDay, place, priceMicros, deliveryBy, offeredAt } = {}) {
  if (!exactId(place) || place.type !== "GeoPlaceIdentity") throw new TypeError("research offer requires a content-valid place");
  if (typeof supplier !== "string" || supplier.trim() === "" || !/^\d{4}-\d{2}-\d{2}$/u.test(civilDay ?? "") || !Number.isSafeInteger(priceMicros) || priceMicros <= 0 || !Number.isFinite(Date.parse(deliveryBy))) throw new TypeError("research offer requires supplier, day, positive safe price, and delivery deadline");
  const productTerms = { climateHistory: true, climateForecast: true, citations: true, uncertaintyAndScenarioLimits: true, publicYoutubeReuseRights: true };
  const object = { type: "ClimateResearchSupplyOffer", civilDay, place, accountingUnit: UNIT, priceMicros, deliveryBy, productTerms };
  const body = { type: "Offer", actor: supplier, target: ACTOR, object, published: offeredAt };
  return { id: contentId(body), ...body };
}

async function record(category, value, options) {
  const at = options.at ?? new Date().toISOString();
  if (options.settlement) { await recordSettlementRecord({ agentUrl: options.witnessJournalAgentUrl ?? process.env.WITNESS_JOURNAL_RDF_AGENT, settlement: options.settlement, actor: ACTOR, category, recordedAt: at, record: { ...value } }); return; }
  const store = createSettlementStore({ settlementRoot: NODE_ROOT, agentUrl: options.witnessJournalAgentUrl ?? process.env.WITNESS_JOURNAL_RDF_AGENT }); await store.record({ category, recordedAt: at, record: { ...value } });
}

export async function clearDailyMarket({ civilDay, demandDeliveries = [], supplyDeliveries = [] } = {}, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(civilDay ?? "") || demandDeliveries.length === 0 || supplyDeliveries.length === 0) throw new TypeError("clearing requires a civil day, demand, and supply");
  if (typeof options.verifyDelivery !== "function" || typeof options.verifyPaymentCommitment !== "function") throw new TypeError("clearing requires delivery and payment-commitment verifiers");
  if (new Set(demandDeliveries.map((entry) => entry?.id)).size !== demandDeliveries.length || new Set(supplyDeliveries.map((entry) => entry?.id)).size !== supplyDeliveries.length) throw new TypeError("market inputs contain duplicate bid or offer identities");
  for (const delivery of [...demandDeliveries, ...supplyDeliveries]) if (!exactId(delivery) || delivery.type !== "Offer" || delivery.target !== ACTOR || delivery.object?.civilDay !== civilDay || (await options.verifyDelivery(delivery)) !== true) throw new TypeError("market carrier lacks exact authenticated delivery");
  if (new Set(demandDeliveries.map((entry) => entry.object?.paymentCommitment)).size !== demandDeliveries.length) throw new TypeError("demand bids reuse a payment commitment");
  for (const bid of demandDeliveries) if (bid.object.type !== "ClimateLocationDemandBid" || bid.object.accountingUnit !== UNIT || !exactId(bid.object.place) || typeof bid.actor !== "string" || !Number.isSafeInteger(bid.object.maxValueMicros) || bid.object.maxValueMicros <= 0 || typeof bid.object.paymentCommitment !== "string" || (await options.verifyPaymentCommitment(bid.actor, bid.object.paymentCommitment, bid.object.maxValueMicros, UNIT)) !== true) throw new TypeError("demand bid lacks verified payment commitment");
  for (const offer of supplyDeliveries) if (offer.object.type !== "ClimateResearchSupplyOffer" || offer.object.accountingUnit !== UNIT || !exactId(offer.object.place) || typeof offer.actor !== "string" || !Number.isSafeInteger(offer.object.priceMicros) || offer.object.priceMicros <= 0 || !Number.isFinite(Date.parse(offer.object.deliveryBy)) || !Object.values(offer.object.productTerms ?? {}).every((value) => value === true)) throw new TypeError("research offer lacks admissible climate product terms");
  const byPlace = new Map();
  for (const bid of demandDeliveries) { const entry = byPlace.get(bid.object.place.id) ?? { place: bid.object.place, bids: [], offers: [] }; entry.bids.push(bid); byPlace.set(entry.place.id, entry); }
  for (const offer of supplyDeliveries) { const entry = byPlace.get(offer.object.place.id); if (entry) entry.offers.push(offer); }
  const candidates = [];
  for (const entry of byPlace.values()) {
    if (entry.offers.length === 0) continue;
    const demand = entry.bids.reduce((sum, bid) => sum + BigInt(bid.object.maxValueMicros), 0n);
    const supply = [...entry.offers].sort((a, b) => a.object.priceMicros - b.object.priceMicros || a.id.localeCompare(b.id))[0];
    const cost = BigInt(supply.object.priceMicros), surplus = demand - cost; if (surplus < 0n) continue;
    if (demand > BigInt(Number.MAX_SAFE_INTEGER) || surplus > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("market aggregate exceeds safe accounting bounds");
    candidates.push({ place: entry.place, bids: entry.bids, supply, aggregateDemandMicros: Number(demand), researchCostMicros: supply.object.priceMicros, surplusMicros: Number(surplus) });
  }
  if (candidates.length === 0) throw new TypeError("no location has admissible nonnegative surplus");
  candidates.sort((a, b) => b.surplusMicros - a.surplusMicros || b.aggregateDemandMicros - a.aggregateDemandMicros || a.researchCostMicros - b.researchCostMicros || a.place.id.localeCompare(b.place.id) || a.supply.id.localeCompare(b.supply.id));
  const winner = candidates[0], dataRoot = resolve(options.dataRoot ?? join(NODE_ROOT, "data")), runtimeRoot = resolve(options.runtimeRoot ?? join(NODE_ROOT, "content/runtime/clearing-locks"));
  mkdirSync(runtimeRoot, { recursive: true }); const lock = join(runtimeRoot, civilDay); try { mkdirSync(lock); } catch (error) { if (error?.code === "EEXIST") throw new TypeError("market civil day is concurrently clearing"); throw error; }
  try {
    if ((await querySettlementRecords("climate-location-market.daily-clearing")).some((entry) => entry.civilDay === civilDay)) throw new TypeError("market civil day already cleared");
    const commitments = winner.bids.map((bid) => ({ bid: bid.id, bidder: bid.actor, amountMicros: bid.object.maxValueMicros, paymentCommitment: bid.object.paymentCommitment })).sort((a, b) => a.bid.localeCompare(b.bid));
    const body = { type: "ClimateLocationMarketClearingAdmission", market: ACTOR, customer: CHANNEL, civilDay, timezone: "America/Chicago", place: winner.place, demandBids: commitments.map((entry) => entry.bid), demandCommitments: commitments, researchSupplyOffer: winner.supply.id, researchSupplier: winner.supply.actor, accountingUnit: UNIT, aggregateDemandMicros: winner.aggregateDemandMicros, researchCostMicros: winner.researchCostMicros, surplusMicros: winner.surplusMicros, settlementStatus: "commitments-verified-not-settled", authorityWithheld: ["research-truth", "payment-custody", "channel-editorial-authority", "video-or-publication-authority"], clearedAt: options.at ?? new Date().toISOString() };
    const clearing = { id: contentId(body), ...body }; await record("climate-location-market.daily-clearing", clearing, options); return clearing;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

export async function admitWinningDemandSettlement({ clearing, settlementReceipts = [] } = {}, options = {}) {
  if (!exactId(clearing) || clearing.type !== "ClimateLocationMarketClearingAdmission" || clearing.market !== ACTOR || clearing.settlementStatus !== "commitments-verified-not-settled") throw new TypeError("settlement admission requires the exact preliminary market clearing");
  if (typeof options.verifySettlementReceipt !== "function" || !Array.isArray(settlementReceipts) || settlementReceipts.length !== clearing.demandCommitments.length) throw new TypeError("settlement admission requires one verifier-backed receipt per winning demand commitment");
  if (new Set(settlementReceipts.map((receipt) => receipt?.id)).size !== settlementReceipts.length || settlementReceipts.some((receipt) => typeof receipt?.id !== "string" || receipt.id.trim() === "")) throw new TypeError("settlement receipts require unique identities");
  const receiptsByBid = new Map(settlementReceipts.map((receipt) => [receipt.bid, receipt]));
  if (receiptsByBid.size !== clearing.demandCommitments.length) throw new TypeError("settlement receipts duplicate or omit winning bids");
  let settled = 0n;
  for (const commitment of clearing.demandCommitments) {
    const receipt = receiptsByBid.get(commitment.bid);
    if (!receipt || receipt.payer !== commitment.bidder || receipt.amountMicros !== commitment.amountMicros || receipt.accountingUnit !== clearing.accountingUnit || (await options.verifySettlementReceipt(commitment, receipt)) !== true) throw new TypeError("winning demand settlement receipt does not bind its commitment");
    settled += BigInt(receipt.amountMicros);
  }
  if (settled !== BigInt(clearing.aggregateDemandMicros)) throw new TypeError("settled winning demand does not equal cleared aggregate demand");
  const dataRoot = resolve(options.dataRoot ?? join(NODE_ROOT, "data")), runtimeRoot = resolve(options.runtimeRoot ?? join(NODE_ROOT, "content/runtime/settlement-locks"));
  mkdirSync(runtimeRoot, { recursive: true }); const lock = join(runtimeRoot, digest(clearing.id).slice(7)); try { mkdirSync(lock); } catch (error) { if (error?.code === "EEXIST") throw new TypeError("market clearing is concurrently settling"); throw error; }
  try {
    if ((await querySettlementRecords("climate-location-market.winning-demand-settlement")).some((entry) => entry.clearing === clearing.id)) throw new TypeError("market clearing already has winning-demand settlement");
    const body = { type: "ClimateLocationWinningDemandSettlementAdmission", market: ACTOR, customer: CHANNEL, clearing: clearing.id, civilDay: clearing.civilDay, accountingUnit: clearing.accountingUnit, aggregateSettledDemandMicros: Number(settled), settlementReceipts: settlementReceipts.map((receipt) => receipt.id).sort(), settlementStatus: "winning-demand-settled", authorityWithheld: [...clearing.authorityWithheld], admittedAt: options.at ?? new Date().toISOString() };
    const admission = { id: contentId(body), ...body }; await record("climate-location-market.winning-demand-settlement", admission, options); return admission;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
