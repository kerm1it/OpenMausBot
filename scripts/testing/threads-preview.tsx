import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { ADVANCED_MODE_KEY, setAdvancedMode } from "../../src/lib/interface-mode";
import { GROK_MOVE_NOTICE } from "../../src/lib/notices";
import { setEmailGateDone } from "../../src/lib/onboarding-storage";
import { markSimpleModePromptSeen } from "../../src/lib/simple-mode-prompt";
import { applySkinChoice, readSkinChoice } from "../../src/lib/skins";
import "../../src/styles.css";

const previewFlags = new URLSearchParams(location.search);
if (previewFlags.has("ombVoiceProbe")) {
  (window as typeof window & { __ombVoiceProbe?: unknown[] }).__ombVoiceProbe = [];
}
if (localStorage.getItem(ADVANCED_MODE_KEY) === null) setAdvancedMode(false);
if (!previewFlags.has("onboarding")) setEmailGateDone("skipped");
if (!previewFlags.has("simpleModePrompt")) markSimpleModePromptSeen();
if (!previewFlags.has("grokMovePopup")) localStorage.setItem(GROK_MOVE_NOTICE, "1");
applySkinChoice(readSkinChoice());
createRoot(document.getElementById("root")!).render(<App />);
