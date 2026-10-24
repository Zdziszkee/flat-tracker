/**
 * Rebuild the quarterly, area-stratified RCN price indices used by the
 * per-offer valuation model. Run after an RCN import or assign-buildings:
 *
 *   bun run rebuild:price-indices
 */
import { rebuildPriceIndices } from "../src/db/queries/price-indices.ts";

const report = await rebuildPriceIndices();
console.log(JSON.stringify(report, null, 2));
