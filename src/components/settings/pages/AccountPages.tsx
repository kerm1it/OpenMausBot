import { t } from "@/lib/i18n";
import { productName } from "@/lib/brand";
import { api } from "@/state/store";
import { useState } from "react";
import { InertRow, useSwitchToComputer } from "../inert";
import { PlaceBadge, YouAvatar } from "../SettingsNav";
import { SignOutConfirm } from "../SignOutConfirm";
import { OrganizationSettings } from "../../OrganizationSettings";
import { SettingRow, SettingsGroup, SettingsLinkRow, SettingsRows } from "../../SettingsPrimitives";
import { useAccountSummary, useYou } from "../account-summary";
import { useSettingsShell } from "../settings-shell";
import { profileLabel } from "../../SidebarProfileMenu";

export function AccountPage() {
  const { ctx, place, go } = useSettingsShell();
  const { profile, session } = useYou();
  const summary = useAccountSummary();
  const computer = useSwitchToComputer();
  const [signingOut, setSigningOut] = useState(false);
  const accountOnThisComputer = ctx.desktop && !ctx.client && !ctx.here && !ctx.home;
  const email = summary.email ?? (summary.plan ? profile?.email ?? null : null);
  const sheet = window.ogb?.accountSheet;
  const computerBadge = <PlaceBadge place={{ kind: "computer", name: computer.name, color: null }} size={14} />;
  return <>
    <SettingsGroup block="you">
      <SettingsRows>
        {accountOnThisComputer && computer.open
          ? <SettingsLinkRow title={t("settings.account.nameRow")} badge={computerBadge} value={t("settings.account.onPlace", { place: computer.name })} external onClick={computer.open} data={{ "data-account-name-row": "" }} />
          : <SettingsLinkRow title={t("settings.account.nameRow")} badge={<PlaceBadge place={place} size={14} />} value={profileLabel(profile)} onClick={() => go("bots", "about-you")} data={{ "data-account-name-row": "" }} />}
      </SettingsRows>
    </SettingsGroup>
    {accountOnThisComputer && (
      <SettingsGroup label={t("settings.account.mausbot", { app: productName() })} block="mausbot-account">
        <SettingsRows icons>
          {/* The same card as on This computer: who is signed in (live, it is the person's own), then the way to sign out
              or switch accounts, which happens on This computer, in Sign out's place. Refresh is This computer's only. */}
          <SettingRow title={email ?? t("settings.account.signedIn")} leading={<YouAvatar size={32} />}
            subtitle={summary.signedIn === false ? t("settings.account.notSignedIn") : t("settings.account.signedIn")}>{null}</SettingRow>
          {sheet && <SettingsLinkRow title={t("accounts.manage")} leading={<span aria-hidden="true" />} onClick={() => void sheet.open().catch(() => {})} data={{ "data-account-manage": "" }} />}
          {computer.open && <SettingsLinkRow title={t("settings.account.fromHere", { place: computer.name })} leading={<span aria-hidden="true" />} external onClick={computer.open} data={{ "data-account-elsewhere": "" }} />}
        </SettingsRows>
      </SettingsGroup>
    )}
    {!ctx.desktop && (
      <SettingsGroup block="mausbot-account">
        <SettingsRows>
          <SettingRow title={t("settings.account.signedInTo", { place: place.name })} subtitle={profile?.email}>{null}</SettingRow>
          {session?.kind === "session" && (
            <SettingRow title={t("settings.account.signOutBrowser")}>
              <button type="button" data-danger="" className="settings-quiet cursor-pointer" onClick={() => setSigningOut(true)}>{t("settings.account.signOutShort")}</button>
            </SettingRow>
          )}
        </SettingsRows>
        {signingOut && <SignOutConfirm browser here={place.name} onConfirm={() => api("/api/auth/logout", { method: "POST" }).finally(() => location.reload())} onClose={() => setSigningOut(false)} />}
      </SettingsGroup>
    )}
    {ctx.organization ? (
      <SettingsGroup label={t("settings.section.organization")} block="organization">
        <OrganizationSettings simple={!ctx.advanced} />
      </SettingsGroup>
    ) : accountOnThisComputer && ctx.advanced && (
      <SettingsGroup label={t("settings.section.organization")} block="organization">
        <SettingsRows><InertRow title={t("settings.account.orgSignIn")} control={<button type="button" className="ui-button" tabIndex={-1}>{t("settings.account.signIn")}</button>} /></SettingsRows>
      </SettingsGroup>
    )}
  </>;
}

export function PlanPage() {
  return null;
}
