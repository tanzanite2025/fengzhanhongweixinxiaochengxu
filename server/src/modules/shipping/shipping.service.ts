import type { ShippingRule } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { parseStringArrayJson } from '../../lib/json.js';

export interface ShippableLineItem {
  productId: number;
  productTitle: string;
  quantity: number;
  subtotalCents: number;
  shippingRule: ShippingRule;
}

export interface ShippingCalculationResult {
  shippingFeeCents: number;
  breakdown: Array<{
    ruleId: number;
    ruleName: string;
    feeCents: number;
    freeShippingApplied: boolean;
  }>;
}

function normalizeProvinceKey(raw: string): string {
  return raw
    .trim()
    .replace(/(维吾尔自治区|回族自治区|壮族自治区|自治区|特别行政区|省|市)$/u, '')
    .trim();
}

function isProvinceExcluded(excludedProvinces: string[], receiverProvince: string): boolean {
  const rawTarget = receiverProvince.trim();
  const keyTarget = normalizeProvinceKey(rawTarget);
  if (keyTarget.length === 0) return false;

  return excludedProvinces.some((excluded) => {
    const keyExcluded = normalizeProvinceKey(excluded);
    if (keyExcluded.length === 0) return false;
    if (keyTarget === keyExcluded) return true;
    // Require >= 2 chars before substring match so 1-char typos like "内" cannot falsely match "内蒙古"
    return keyExcluded.length >= 2 && keyTarget.length >= 2 && keyTarget.includes(keyExcluded);
  });
}

/**
 * Calculate deterministic shipping fee grouped by ShippingRule.
 * Throws AppError if any item cannot be delivered to the target province.
 */
export function calculateShippingFee(
  items: ShippableLineItem[],
  receiverProvince: string
): ShippingCalculationResult {
  if (items.length === 0) {
    throw new AppError(400, 'EMPTY_ITEMS', '结算商品不能为空');
  }

  const ruleGroups = new Map<
    number,
    { rule: ShippingRule; totalQuantity: number; totalSubtotalCents: number }
  >();

  for (const item of items) {
    const excluded = parseStringArrayJson(
      item.shippingRule.excludedProvinces,
      `ShippingRule(${item.shippingRule.id}).excludedProvinces`
    );
    if (isProvinceExcluded(excluded, receiverProvince)) {
      throw new AppError(
        400,
        'REGION_NOT_DELIVERABLE',
        `商品「${item.productTitle}」暂不支持配送至：${receiverProvince}`
      );
    }

    const existing = ruleGroups.get(item.shippingRule.id);
    if (existing) {
      existing.totalQuantity += item.quantity;
      existing.totalSubtotalCents += item.subtotalCents;
    } else {
      ruleGroups.set(item.shippingRule.id, {
        rule: item.shippingRule,
        totalQuantity: item.quantity,
        totalSubtotalCents: item.subtotalCents
      });
    }
  }

  let totalFeeCents = 0;
  const breakdown: ShippingCalculationResult['breakdown'] = [];

  for (const { rule, totalQuantity, totalSubtotalCents } of ruleGroups.values()) {
    const freeApplied =
      rule.freeThresholdCents !== null && totalSubtotalCents >= rule.freeThresholdCents;
    const feeCents = freeApplied
      ? 0
      : rule.baseFeeCents + Math.max(0, totalQuantity - 1) * rule.extraItemFeeCents;

    totalFeeCents += feeCents;
    breakdown.push({
      ruleId: rule.id,
      ruleName: rule.name,
      feeCents,
      freeShippingApplied: freeApplied
    });
  }

  return { shippingFeeCents: totalFeeCents, breakdown };
}
