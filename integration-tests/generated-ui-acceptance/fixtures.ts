/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixture data and expected results for the #14019 acceptance cases.
 *
 * The issue states results (CNY 924 / 154, 964.85, 137.84 / 137.83,
 * 6739.20 / 10483.20 / 14227.20) without inputs. The inputs below are chosen
 * so that the stated rules reproduce those figures; the expected values are
 * computed from the rules, and `fixtures.test.ts` checks the computation
 * against the issue's numbers. A checker never compares against a literal that
 * the rule did not produce.
 */

import { roundCents, splitCents } from './money.js';

export interface BillInputs {
  /** Food subtotal in cents. */
  subtotal: number;
  people: number;
  /** Discount in cents, applied before the service fee. */
  discount: number;
  /** Service fee in percent of the discounted subtotal. */
  serviceRate: number;
}

export const BILL_DEFAULTS: BillInputs = {
  subtotal: 90_000,
  people: 6,
  discount: 6_000,
  serviceRate: 10,
};

export const BILL_SCENARIO: BillInputs = {
  subtotal: 90_000,
  people: 7,
  discount: 6_100,
  serviceRate: 15,
};

/** Total in cents: (subtotal - discount) * (1 + rate), rounded once. */
export function billTotal(inputs: BillInputs): number {
  return roundCents(
    ((inputs.subtotal - inputs.discount) * (100 + inputs.serviceRate)) / 100,
  );
}

/** Per-person shares in cents; leftover cents go to the first people. */
export function billShares(inputs: BillInputs): number[] {
  return splitCents(billTotal(inputs), inputs.people);
}

export type Plan = 'basic' | 'pro' | 'team';
export const PLANS: readonly Plan[] = ['basic', 'pro', 'team'];

/** List price per seat per month, in cents. */
export const PLAN_PRICES: Record<Plan, number> = {
  basic: 3_900,
  pro: 6_900,
  team: 9_900,
};

/** Annual billing discount in percent; it applies to plan prices only. */
export const ANNUAL_DISCOUNT = 20;
/** Support add-on per seat per month, in cents, never discounted. */
export const SUPPORT_PRICE = 1_200;

export interface ComparatorInputs {
  seats: number;
  billing: 'monthly' | 'annual';
  support: boolean;
}

export const COMPARATOR_SCENARIO: ComparatorInputs = {
  seats: 13,
  billing: 'annual',
  support: true,
};
export const COMPARATOR_SELECTED_PLAN: Plan = 'team';

/** What the customer actually pays per billing period, in cents. */
export function comparatorPayment(
  plan: Plan,
  inputs: ComparatorInputs,
): number {
  const seatMonths = inputs.seats * (inputs.billing === 'annual' ? 12 : 1);
  const planCost =
    (PLAN_PRICES[plan] *
      seatMonths *
      (inputs.billing === 'annual' ? 100 - ANNUAL_DISCOUNT : 100)) /
    100;
  const supportCost = inputs.support ? SUPPORT_PRICE * seatMonths : 0;
  return roundCents(planCost + supportCost);
}

/** Monthly equivalent of the period payment, in cents. */
export function comparatorMonthlyEquivalent(
  plan: Plan,
  inputs: ComparatorInputs,
): number {
  const payment = comparatorPayment(plan, inputs);
  return inputs.billing === 'annual' ? roundCents(payment / 12) : payment;
}
