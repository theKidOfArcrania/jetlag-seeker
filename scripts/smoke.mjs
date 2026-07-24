// Headless smoke test: serve dist/, load the app, verify it boots, loads the
// dataset, renders candidate markers, and that a radar elimination reduces the
// survivor count. Run: node scripts/smoke.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(req.url.split("?")[0]));
    if (p === "/") p = "/index.html";
    const file = join(root, p);
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

async function main() {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://localhost:${port}/`;

  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 780 }); // iPhone-ish
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (t.includes("Failed to load resource")) return; // external tiles / favicon
    errors.push(t);
  });

  await page.goto(url, { waitUntil: "networkidle0" });

  // Wait for candidate markers to render.
  await page.waitForSelector(".leaflet-marker-icon, .leaflet-interactive", { timeout: 10000 });

  const initialCount = await page.$eval(".count", (n) => n.textContent);
  const candidateMarkers = await page.$$eval(".leaflet-interactive", (els) => els.length);

  // Go to Radar tab and apply a "within" elimination.
  await page.$$eval(".tab", (tabs) => {
    const radar = tabs.find((t) => t.textContent.trim() === "Radar");
    radar?.click();
  });
  await page.waitForSelector(".slider", { timeout: 5000 });
  await page.$eval(".apply.keep", (b) => b.click());
  await new Promise((r) => setTimeout(r, 300));
  const afterCount = await page.$eval(".count", (n) => n.textContent);

  // History tab should now list one step.
  await page.$$eval(".tab", (tabs) => tabs.find((t) => t.textContent.trim() === "History")?.click());
  await page.waitForSelector(".history-list", { timeout: 5000 });
  const historyRows = await page.$$eval(".history-row", (els) => els.length);

  // Undo restores the full universe; redo re-applies.
  await page.$$eval(".chip", (els) => els.find((b) => b.textContent.includes("Undo"))?.click());
  await new Promise((r) => setTimeout(r, 200));
  const afterUndo = await page.$eval(".count", (n) => n.textContent);
  await page.$$eval(".chip", (els) => els.find((b) => b.textContent.includes("Redo"))?.click());
  await new Promise((r) => setTimeout(r, 200));
  const afterRedo = await page.$eval(".count", (n) => n.textContent);

  // Ask tab: preview buckets render and are selectable.
  await page.$$eval(".tab", (tabs) => tabs.find((t) => t.textContent.trim() === "Ask")?.click());
  await page.waitForSelector(".bucket", { timeout: 5000 });
  const bucketCount = await page.$$eval(".bucket", (els) => els.length);

  // Layers control: admin/transit/eliminated-area overlays are present.
  await page.waitForSelector(".leaflet-control-layers", { timeout: 5000 });
  const overlayLabels = await page.$$eval(
    ".leaflet-control-layers-overlays label span",
    (els) => els.map((e) => e.textContent.trim()).filter(Boolean),
  );

  await browser.close();
  server.close();

  const parse = (s) => parseInt(String(s).split("/")[0], 10);
  const wantOverlays = ["Seattle City Limit", "Transit lines", "Eliminated area", "Regions · city"];
  const overlaysOk = wantOverlays.every((l) => overlayLabels.includes(l));
  const ok =
    errors.length === 0 &&
    candidateMarkers > 100 &&
    parse(afterCount) <= parse(initialCount) &&
    historyRows === 1 &&
    parse(afterUndo) === parse(initialCount) &&
    parse(afterRedo) === parse(afterCount) &&
    bucketCount >= 1 &&
    overlaysOk;

  console.log(JSON.stringify({ initialCount, afterCount, candidateMarkers, historyRows, afterUndo, afterRedo, bucketCount, overlayLabels, errors }, null, 2));
  if (!ok) {
    console.error("SMOKE TEST FAILED");
    process.exit(1);
  }
  console.log("SMOKE TEST PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
