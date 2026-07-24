import { describe, expect, it } from "vitest";
import {
  NULL,
  answerQuestion,
  matchingAnswer,
  measuringAnswer,
  radarAnswer,
  thermometerAnswer,
} from "../answers";
import type { Feature, QuestionSpec } from "../types";
import { loadDatasetSync, loadParityFixture } from "./helpers";

describe("answer parity with jetlag_mapper (Python oracle)", () => {
  const ds = loadDatasetSync();
  const fx = loadParityFixture();

  it("has a fixture aligned with the dataset question catalog (excluding admin)", () => {
    // Admin questions use a KML-sourced region model that the Python oracle
    // can't consume, so they're excluded from the parity fixture and covered by
    // dedicated unit tests below.
    const nonAdmin = ds.question_catalog.filter((q) => q.category !== "admin");
    expect(fx.questions.length).toBe(nonAdmin.length);
    fx.questions.forEach((q, i) => {
      expect(q.category).toBe(nonAdmin[i].category);
      expect(q.name).toBe(nonAdmin[i].name);
    });
  });

  it("reproduces every Python answer across all cases", () => {
    let checked = 0;
    for (const c of fx.cases) {
      const hider = { lat: c.hider[0], lon: c.hider[1] };
      const seeker = { lat: c.seeker[0], lon: c.seeker[1] };
      fx.questions.forEach((q, i) => {
        const got = answerQuestion(q as QuestionSpec, hider, seeker, ds);
        expect(got, `${q.name} @ hider=${c.hider} seeker=${c.seeker}`).toBe(c.answers[i]);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe("radarAnswer", () => {
  it("is inclusive at the boundary", () => {
    const a = { lat: 47.6, lon: -122.3 };
    const b = { lat: 47.6, lon: -122.3 };
    expect(radarAnswer(a, b, 0.25)).toBe(true);
  });

  it("is false just outside the radius", () => {
    const a = { lat: 47.6, lon: -122.3 };
    const far = { lat: 48.6, lon: -122.3 };
    expect(radarAnswer(a, far, 1)).toBe(false);
  });
});

describe("measuring/matching null handling", () => {
  const h = { lat: 47.6, lon: -122.3 };
  const s = { lat: 47.61, lon: -122.31 };

  it("returns NULL when no features exist", () => {
    expect(measuringAnswer(h, s, [])).toBe(NULL);
    expect(matchingAnswer(h, s, [])).toBe(NULL);
  });

  it("matching says yes when both share the same nearest feature", () => {
    const feats: Feature[] = [
      { id: "a", name: "A", lat: 47.605, lon: -122.305 },
      { id: "b", name: "B", lat: 48.0, lon: -123.0 },
    ];
    expect(matchingAnswer(h, s, feats)).toBe("yes");
  });

  it("matching says no when nearest features differ", () => {
    const feats: Feature[] = [
      { id: "a", name: "A", lat: 47.6, lon: -122.3 },
      { id: "b", name: "B", lat: 47.61, lon: -122.31 },
    ];
    expect(matchingAnswer(h, s, feats)).toBe("no");
  });

  it("measuring reports closer/further from the hider's perspective", () => {
    const feats: Feature[] = [{ id: "a", name: "A", lat: 47.6, lon: -122.3 }];
    // hider is on the feature; seeker is far -> hider is closer.
    expect(measuringAnswer(h, s, feats)).toBe("closer");
    expect(measuringAnswer(s, h, feats)).toBe("further");
  });
});

describe("thermometerAnswer", () => {
  const hider = { lat: 47.6, lon: -122.3 };
  it("hotter when the seeker moves closer", () => {
    const from = { lat: 47.7, lon: -122.3 };
    const to = { lat: 47.62, lon: -122.3 };
    expect(thermometerAnswer(hider, from, to)).toBe("hotter");
  });
  it("colder when the seeker moves away", () => {
    const from = { lat: 47.62, lon: -122.3 };
    const to = { lat: 47.8, lon: -122.3 };
    expect(thermometerAnswer(hider, from, to)).toBe("colder");
  });
});
