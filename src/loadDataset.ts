import type { Dataset } from "./types";

export async function fetchDataset(): Promise<Dataset> {
  const url = `${import.meta.env.BASE_URL}data/dataset.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load dataset (${res.status}) from ${url}`);
  return (await res.json()) as Dataset;
}
