// Synchronous dataset loader for Node/test contexts (reads the built JSON asset).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Dataset } from "../types";

const here = dirname(fileURLToPath(import.meta.url));

export function loadDatasetSync(): Dataset {
  const p = resolve(here, "../../public/data/dataset.json");
  return JSON.parse(readFileSync(p, "utf-8")) as Dataset;
}

export function loadParityFixture(): {
  questions: { category: string; name: string; payload: string | number }[];
  cases: { hider: [number, number]; seeker: [number, number]; answers: (boolean | string)[] }[];
} {
  const p = resolve(here, "./parity_fixture.json");
  return JSON.parse(readFileSync(p, "utf-8"));
}
