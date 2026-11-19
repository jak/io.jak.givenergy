'use strict';

/**
 * Threshold-crossing flow cards.
 *
 * Each flow has one boolean, `above = value > threshold`. "rose above" fires when it flips
 * false -> true and "dropped below" when it flips true -> false, so the two alternate strictly,
 * fire once per crossing, and agree with the "is above" condition.
 *
 * Devices trigger both cards on every change with state { previous, current }; the run
 * listeners registered in app.ts decide per flow (per threshold) whether it crossed.
 */

export interface Crossing {
  previous: number;
  current: number;
}

export interface Metric {
  /** Capability id; card ids are `<id>_rose_above`, `<id>_dropped_below`, `<id>_above`. */
  id: 'grid_voltage' | 'grid_frequency' | 'load_power' | 'grid_power';
  /** Name of the threshold arg in the card JSON. */
  argName: string;
  /** Whether an `<id>_above` condition card exists. */
  hasCondition: boolean;
}

export type MetricId = Metric['id'];

export const METRICS: readonly Metric[] = [
  { id: 'grid_voltage', argName: 'voltage', hasCondition: false },
  { id: 'grid_frequency', argName: 'frequency', hasCondition: false },
  { id: 'load_power', argName: 'power', hasCondition: true },
  { id: 'grid_power', argName: 'power', hasCondition: true },
];

export function isAbove(value: number, threshold: number): boolean {
  return value > threshold;
}

export function roseAbove({ previous, current }: Crossing, threshold: number): boolean {
  return !isAbove(previous, threshold) && isAbove(current, threshold);
}

export function droppedBelow({ previous, current }: Crossing, threshold: number): boolean {
  return isAbove(previous, threshold) && !isAbove(current, threshold);
}

export type TriggerFn = (cardId: string, tokens: { value: number }, state: Crossing) => void;

/** Tracks the last value per metric and fires both crossing cards when it changes. */
export class ThresholdTracker {
  private readonly last = new Map<MetricId, number>();
  private readonly trigger: TriggerFn;

  constructor(trigger: TriggerFn) {
    this.trigger = trigger;
  }

  update(values: Partial<Record<MetricId, number>>): void {
    for (const [id, current] of Object.entries(values) as [MetricId, number | undefined][]) {
      if (typeof current !== 'number' || Number.isNaN(current)) continue;
      const previous = this.last.get(id);
      this.last.set(id, current);
      if (previous === undefined || previous === current) continue;
      const state = { previous, current };
      this.trigger(`${id}_rose_above`, { value: current }, state);
      this.trigger(`${id}_dropped_below`, { value: current }, state);
    }
  }
}
