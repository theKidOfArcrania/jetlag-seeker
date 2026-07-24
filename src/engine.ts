// Elimination engine: the pure, framework-agnostic core of the app.
//
// The candidate universe is the set of reachable hider stations. Each applied
// "step" is a question asked from a seeker location with an observed answer; a
// candidate survives a step iff its *computed* answer equals the observed one.
// Cumulative survivors = candidates that survive every applied step. History is
// an undo/redo stack of steps.

import { answerQuestion, possibleAnswers, thermometerAnswer, type Answer } from "./answers";
import type { Candidate, Dataset, LatLon, QuestionCategory, QuestionSpec } from "./types";

export interface StepSpec {
  category: QuestionCategory;
  payload: string | number;
  seeker: LatLon;
  seekerTo?: LatLon; // thermometer destination
}

export interface Step extends StepSpec {
  id: string;
  label: string;
  answer: Answer;
}

let stepCounter = 0;
function nextId(): string {
  stepCounter += 1;
  return `step-${stepCounter}-${Date.now()}`;
}

// Compute what answer a given hider candidate would give for a step/spec.
export function evaluate(ds: Dataset, spec: StepSpec, hider: LatLon): Answer {
  if (spec.category === "thermometer") {
    if (!spec.seekerTo) throw new Error("thermometer step requires seekerTo");
    return thermometerAnswer(hider, spec.seeker, spec.seekerTo);
  }
  const q: QuestionSpec = {
    category: spec.category,
    name: `${spec.category}:${spec.payload}`,
    payload: spec.payload,
  };
  return answerQuestion(q, hider, spec.seeker, ds);
}

export interface PreviewBucket {
  answer: Answer;
  survivors: Candidate[];
}

export class EliminationEngine {
  readonly ds: Dataset;
  private steps: Step[] = [];
  private redo: Step[] = [];

  constructor(ds: Dataset) {
    this.ds = ds;
  }

  /** All candidates that survive every applied step. */
  survivors(): Candidate[] {
    let alive = this.ds.candidates;
    for (const step of this.steps) {
      alive = alive.filter((c) => equalAnswer(evaluate(this.ds, step, c), step.answer));
    }
    return alive;
  }

  /** True if an arbitrary location would survive every applied step (used to
   * classify grid cells for the eliminated-area overlay). */
  survivesAll(loc: LatLon): boolean {
    for (const step of this.steps) {
      if (!equalAnswer(evaluate(this.ds, step, loc), step.answer)) return false;
    }
    return true;
  }

  /** Candidates eliminated by the applied steps (complement of survivors). */
  eliminated(): Candidate[] {
    const alive = new Set(this.survivors().map((c) => c.id));
    return this.ds.candidates.filter((c) => !alive.has(c.id));
  }

  /**
   * Group candidates by the answer they would give for `spec`, without mutating
   * state. Powers the preview panel and shading.
   *
   * Buckets are enumerated over the *full candidate universe* so that every
   * answer a real hider station could truthfully give is offered — including an
   * answer that no *current survivor* would give. Such a bucket has zero
   * survivors, and applying it eliminates all remaining candidates (the seeker
   * may still need to record a truthful answer their candidate set can't explain).
   * Each bucket's `survivors` counts only current survivors.
   */
  preview(spec: StepSpec): PreviewBucket[] {
    const survivorIds = new Set(this.survivors().map((c) => c.id));
    const byAnswer = new Map<string, PreviewBucket>();
    // Seed a bucket for every answer the question can produce, so options that no
    // candidate realizes still appear (with zero survivors) and can be applied.
    for (const ans of possibleAnswers(spec.category, spec.payload, this.ds)) {
      byAnswer.set(answerKey(ans), { answer: ans, survivors: [] });
    }
    for (const c of this.ds.candidates) {
      const ans = evaluate(this.ds, spec, c);
      const key = answerKey(ans);
      let bucket = byAnswer.get(key);
      if (!bucket) {
        bucket = { answer: ans, survivors: [] };
        byAnswer.set(key, bucket);
      }
      if (survivorIds.has(c.id)) bucket.survivors.push(c);
    }
    return [...byAnswer.values()].sort((a, b) => b.survivors.length - a.survivors.length);
  }

  /** Survivors that would remain if `spec` were answered `answer`. */
  survivorsIf(spec: StepSpec, answer: Answer): Candidate[] {
    return this.survivors().filter((c) => equalAnswer(evaluate(this.ds, spec, c), answer));
  }

  apply(spec: StepSpec, answer: Answer, label?: string): Step {
    const step: Step = {
      ...spec,
      id: nextId(),
      answer,
      label: label ?? defaultLabel(spec, answer),
    };
    this.steps.push(step);
    this.redo = []; // applying a new step invalidates the redo branch
    return step;
  }

  canUndo(): boolean {
    return this.steps.length > 0;
  }

  canRedo(): boolean {
    return this.redo.length > 0;
  }

  undo(): Step | null {
    const step = this.steps.pop();
    if (!step) return null;
    this.redo.push(step);
    return step;
  }

  redoStep(): Step | null {
    const step = this.redo.pop();
    if (!step) return null;
    this.steps.push(step);
    return step;
  }

  history(): readonly Step[] {
    return this.steps;
  }

  /** Cumulative survivor counts: [initial, after step 1, after step 2, ...]. */
  survivorTrail(): number[] {
    const trail = [this.ds.candidates.length];
    let alive = this.ds.candidates;
    for (const step of this.steps) {
      alive = alive.filter((c) => equalAnswer(evaluate(this.ds, step, c), step.answer));
      trail.push(alive.length);
    }
    return trail;
  }

  reset(): void {
    this.steps = [];
    this.redo = [];
  }

  /** Serializable snapshot for persistence. */
  toJSON(): { steps: Step[] } {
    return { steps: this.steps };
  }

  loadSteps(steps: Step[]): void {
    this.steps = steps.map((s) => ({ ...s }));
    this.redo = [];
    for (const s of steps) {
      const n = Number(s.id.split("-")[1]);
      if (!Number.isNaN(n) && n > stepCounter) stepCounter = n;
    }
  }
}

// Answers are boolean | string; JSON round-trips keep those types, so a stable
// string key lets us bucket and compare them uniformly.
function answerKey(a: Answer): string {
  return typeof a === "boolean" ? (a ? "true" : "false") : a;
}

export function equalAnswer(a: Answer, b: Answer): boolean {
  return answerKey(a) === answerKey(b);
}

function defaultLabel(spec: StepSpec, answer: Answer): string {
  const ans = typeof answer === "boolean" ? (answer ? "yes" : "no") : answer;
  switch (spec.category) {
    case "radar":
      return `Radar ${spec.payload} mi → ${ans}`;
    case "thermometer":
      return `Thermometer → ${ans}`;
    case "measuring":
      return `Measuring ${spec.payload} → ${ans}`;
    case "matching":
      return `Matching ${spec.payload} → ${ans}`;
    case "admin": {
      const adminLabels: Record<string, string> = {
        city: "City",
        neighborhood: "Neighborhood",
        neighborhood_region: "Neighborhood region",
      };
      const label = adminLabels[String(spec.payload)] ?? String(spec.payload);
      return `Region · ${label} → ${ans}`;
    }
    case "coast":
      return `Coastline → ${ans}`;
    default:
      return `${spec.category} → ${ans}`;
  }
}
