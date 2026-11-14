import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], qrValues: [] as string[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => { f.qrValues.push(value); return createElement("span", { "data-qr": true }); },
}));

import { ServerPairingCard, type PairingOffer } from "./ServerPairingCard";

const browserUrl = "https://maus.example.com/pair#code=ABCD-EFGH-JK23";
const appUrl = `openmausbot://pair?address=${encodeURIComponent("https://maus.example.com")}&token=omb_pair_${"a".repeat(43)}`;

beforeEach(() => {
  const offer: PairingOffer = { id: "pair-1", code: "ABCD-EFGH-JK23", expiresAt: Date.now() + 300_000, url: browserUrl, inviteUrl: appUrl, hint: null };
  f.values = [{ kind: "loopback" }, true, null, "admin", offer, [], null, false, "idle", null, Date.now()];
  f.index = 0;
  f.effects = [];
  f.qrValues = [];
});

it("encodes the native invitation in the QR and presents the HTTPS link to browser users", () => {
  const html = renderToStaticMarkup(createElement(() => ServerPairingCard({ initialSession: { kind: "loopback" } })));
  expect(f.qrValues).toEqual([appUrl]);
  expect(html).toContain(browserUrl);
});
