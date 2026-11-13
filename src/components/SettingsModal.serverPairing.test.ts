import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsSection } from "@/state/store";
import { SettingsModal } from "./SettingsModal";

// These pin the card as always offered; the server decides who may act.
const fixture = vi.hoisted(() => ({ section: "companion" as AppSettingsSection, config: undefined as { cloudHome?: boolean; managedPolicy?: { remoteAccess: boolean; organizationName: string } } | undefined, phonePairing: 0 }));
// Pinned to Advanced: these cover the Advanced rail; Simple has its own suite.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: fixture.section, config: fixture.config, appSettingsPhonePairing: fixture.phonePairing }, dispatch: vi.fn() }),
}));
vi.mock("./RemoteComputerSection", () => ({ RemoteComputerSection: () => null }));
vi.mock("./CustomDomainSettings", () => ({ CustomDomainSettings: ({ blocked }: { blocked?: string | null }) => `CUSTOM_DOMAIN_MARKER blocked=${blocked ?? ""}` }));
vi.mock("./PhoneDevicesSection", () => ({ PhoneDevicesSection: ({ focusRequest }: { focusRequest?: number }) => `COMPANION_SECTION focus=${focusRequest ?? 0}` }));
vi.mock("./ServerPairingCard", () => ({ ServerPairingCard: ({ cloudHome, focusRequest, remoteAccessBlocked }: { cloudHome?: boolean; focusRequest?: number; remoteAccessBlocked?: string | null }) => `SERVER_PAIRING_CARD_MARKER${cloudHome ? " cloud" : ""} focus=${focusRequest ?? 0} blocked=${remoteAccessBlocked ?? ""}` }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "companion";
  fixture.config = undefined;
  fixture.phonePairing = 0;
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));

describe("Settings → Remote access: server pairing card visibility", () => {
  it("is offered on a hosted server reached from a browser (no window.ogb)", () => {
    vi.stubGlobal("window", {});
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER");
  });

  it("is offered inside the desktop app when it owns the server being paired against", () => {
    vi.stubGlobal("window", { ogb: {} });
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER");
  });

  it("offers this computer's server pairing and custom domain beside its companion pairing", () => {
    vi.stubGlobal("window", { ogb: { companion: {} } });
    const html = render();
    expect(html).toContain("COMPANION_SECTION");
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER");
    expect(html).toContain("CUSTOM_DOMAIN_MARKER");
  });

  it("carries a managed remote-access refusal into both self-hosted controls", () => {
    fixture.config = { managedPolicy: { remoteAccess: false, organizationName: "Fixture Agency" } };
    vi.stubGlobal("window", { ogb: { companion: {} } });
    const html = render();
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER focus=0 blocked=Managed by Fixture Agency");
    expect(html).toContain("CUSTOM_DOMAIN_MARKER blocked=Managed by Fixture Agency");
  });

  it("is offered when this desktop is a remote client of a hosted workspace, whose phones pair only here", () => {
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER");
  });

  it("on an OMB Cloud home, which is personal, tells the card so and offers no People section to invite anyone", () => {
    vi.stubGlobal("window", {});
    expect(render()).toContain(">People<");
    fixture.config = { cloudHome: true };
    const html = render();
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER cloud");
    expect(html).not.toContain(">People<");
  });
});

describe("Settings → Phone & devices opened by Connect your phone", () => {
  it("on this computer, reveals the phone flow, not the server's pairing code", () => {
    fixture.phonePairing = 3;
    vi.stubGlobal("window", { ogb: { companion: {} } });
    const html = render();
    expect(html).toContain("COMPANION_SECTION focus=3");
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER focus=0");
  });

  it("on the person's own Cloud in this window, reveals the Cloud's own pairing code", () => {
    fixture.phonePairing = 2;
    fixture.config = { cloudHome: true };
    vi.stubGlobal("window", { ogb: { cloudPlan: {} } });
    const html = render();
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER cloud focus=2");
    expect(html).not.toContain("COMPANION_SECTION");
  });

  it("on another server, in a browser or as a remote client, reveals that server's pairing code", () => {
    fixture.phonePairing = 1;
    vi.stubGlobal("window", {});
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER focus=1");
    vi.stubGlobal("window", { ogb: { companion: {}, remoteClient: { active: true } } });
    const html = render();
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER focus=1");
    expect(html).not.toContain("COMPANION_SECTION");
  });

  it("a plain visit reveals nothing", () => {
    vi.stubGlobal("window", { ogb: { companion: {} } });
    const html = render();
    expect(html).toContain("COMPANION_SECTION focus=0");
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER focus=0");
  });

  it("this computer's page is Phone & devices; a server's own page is This server", () => {
    vi.stubGlobal("window", { ogb: { companion: {} } });
    expect(render()).toContain(">Phone &amp; devices<");
    vi.stubGlobal("window", {});
    expect(render()).toContain(">This server<");
  });
});
