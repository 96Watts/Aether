import { useEffect, useState, type ReactNode } from "react";

/**
 * EulaGate
 * ---------------------------------------------------------------------------
 * Blocks the app behind a EULA acceptance screen until the user agrees to the
 * current version of the license. Runs on every launch, including after a
 * silent auto-update, since it checks a stored version number rather than
 * only firing on first-ever install.
 *
 * Usage:
 *   <EulaGate>
 *     <App />
 *   </EulaGate>
 *
 * Wire up storage in loadAcceptedVersion / saveAcceptedVersion below —
 * defaults to localStorage, swap for Tauri's fs/store plugin if you'd rather
 * keep it out of the webview's storage.
 */

// Bump this string whenever the EULA text changes. Existing users who
// accepted an older version will be re-prompted automatically.
const CURRENT_EULA_VERSION = "2026-09-05";

const STORAGE_KEY = "aether.eula.acceptedVersion";

const EULA_TEXT = `END-USER LICENSE AGREEMENT (EULA)
AETHER

Copyright © 2026 96Watts. All rights reserved.
Last updated: 05/09/2026

PLEASE READ THIS END-USER LICENSE AGREEMENT ("AGREEMENT") CAREFULLY BEFORE
INSTALLING OR USING AETHER ("SOFTWARE"). BY INSTALLING, COPYING, OR
OTHERWISE USING THE SOFTWARE, YOU AGREE TO BE BOUND BY THE TERMS OF THIS
AGREEMENT. IF YOU DO NOT AGREE TO THESE TERMS, DO NOT INSTALL OR USE THE
SOFTWARE.

1. LICENSE GRANT

Subject to your compliance with this Agreement, 96Watts ("Licensor")
grants you a personal, non-exclusive, non-transferable, revocable, limited
license to install and use the Software, in executable form only, on
devices you own or control, for your own personal or internal use.

This license does not grant you any rights to the source code of the
Software.

2. RESTRICTIONS

You agree that you will not, and will not permit any third party to:

  a. Copy, modify, adapt, translate, or create derivative works of the
     Software;
  b. Reverse engineer, decompile, disassemble, or otherwise attempt to
     derive the source code of the Software, except to the extent such
     restriction is expressly prohibited by applicable law;
  c. Distribute, sell, rent, lease, sublicense, or otherwise transfer the
     Software or any rights granted under this Agreement to any third
     party;
  d. Remove, alter, or obscure any proprietary notices (including
     copyright and trademark notices) on or in the Software;
  e. Use the Software for any unlawful purpose, or in any manner that
     could damage, disable, overburden, or impair the Software or
     interfere with any third party's use of it;
  f. Use the Software to build a competing product or service.

3. OWNERSHIP

The Software is licensed, not sold. Licensor retains all right, title,
and interest in and to the Software, including all intellectual property
rights therein. All rights not expressly granted to you in this Agreement
are reserved by Licensor.

4. THIRD-PARTY SERVICES AND DATA

The Software may allow you to connect to third-party AI providers and
services (including, without limitation, OpenAI, OpenRouter, and other
OpenAI-compatible APIs), or to a locally running Ollama instance.

  a. Your use of any third-party provider is governed by that provider's
     own terms of service and privacy policy, and is your sole
     responsibility.
  b. When you use a cloud-based provider, your prompts and conversation
     data are transmitted to and processed by that provider according to
     its own policies. Licensor does not control, and is not responsible
     for, how third-party providers handle your data.
  c. Provider API keys and credentials you supply are stored locally on
     your device (e.g. via the Windows Credential Manager). You are
     solely responsible for safeguarding your own credentials.
  d. Conversations and settings stored locally by the Software are not
     encrypted and are readable by anyone with access to your device.
     You are responsible for securing your own device and data.

5. NO WARRANTY

THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE IMPLIED
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE,
AND NON-INFRINGEMENT. LICENSOR DOES NOT WARRANT THAT THE SOFTWARE WILL BE
UNINTERRUPTED, ERROR-FREE, OR FREE OF HARMFUL COMPONENTS, OR THAT ANY
DATA WILL REMAIN SECURE OR UNCORRUPTED.

6. LIMITATION OF LIABILITY

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL
LICENSOR BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL,
OR PUNITIVE DAMAGES, OR ANY LOSS OF DATA, PROFITS, OR REVENUE, ARISING
OUT OF OR RELATED TO YOUR USE OF OR INABILITY TO USE THE SOFTWARE, EVEN
IF LICENSOR HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
LICENSOR'S TOTAL LIABILITY ARISING OUT OF OR RELATED TO THIS AGREEMENT
SHALL NOT EXCEED THE AMOUNT YOU PAID FOR THE SOFTWARE, IF ANY.

Nothing in this Agreement excludes or limits any liability that cannot be
excluded or limited under applicable mandatory law, including mandatory
consumer protection law applicable to users who qualify as consumers
under the law of their country of residence.

7. UPDATES

The Software may periodically check for and install updates. You
acknowledge that updates may be required for the Software to continue
functioning correctly, and that this Agreement applies to all updates
unless accompanied by separate terms.

8. TERMINATION

This Agreement is effective until terminated. Your rights under this
Agreement will terminate automatically without notice if you fail to
comply with any of its terms. Upon termination, you must cease all use
of the Software and destroy all copies in your possession.

9. GOVERNING LAW

This Agreement shall be governed by and construed in accordance with the
laws of the Netherlands, without regard to its conflict of law
principles. Where you are a consumer resident in the European Union, this
choice of law does not deprive you of any protection afforded to you by
mandatory provisions of the law of your country of habitual residence.

10. CHANGES TO THIS AGREEMENT

Licensor may update this Agreement from time to time. Continued use of
the Software after any such changes constitutes your acceptance of the
new terms.

11. CONTACT

For questions about this Agreement or to request permissions beyond
those granted here, contact: couperusfred@gmail.com

BY CLICKING "I AGREE," OR BY INSTALLING OR USING THE SOFTWARE, YOU
ACKNOWLEDGE THAT YOU HAVE READ THIS AGREEMENT, UNDERSTAND IT, AND AGREE
TO BE BOUND BY ITS TERMS.

Copyright holder: 96Watts
Year: 2026`;

function loadAcceptedVersion(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveAcceptedVersion(version: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, version);
  } catch {
    // If storage is unavailable, the user will simply be re-prompted next
    // launch — fail safe rather than silently treating it as accepted.
  }
}

export function EulaGate({ children }: { children: ReactNode }) {
  const [accepted, setAccepted] = useState(false);
  const [hasScrolledToEnd, setHasScrolledToEnd] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setAccepted(loadAcceptedVersion() === CURRENT_EULA_VERSION);
  }, []);

  if (accepted) {
    return <>{children}</>;
  }

  function handleAgree() {
    saveAcceptedVersion(CURRENT_EULA_VERSION);
    setAccepted(true);
  }

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const reachedEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    if (reachedEnd) setHasScrolledToEnd(true);
  }

  const canAgree = checked && hasScrolledToEnd;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="eula-title"
      style={styles.overlay}
    >
      <div style={styles.card}>
        <div style={styles.header}>
          <h1 id="eula-title" style={styles.title}>
            License agreement
          </h1>
          <p style={styles.subtitle}>
            Please review the terms before continuing to use Aether.
          </p>
        </div>

        <div style={styles.textBox} onScroll={handleScroll}>
          <pre style={styles.pre}>{EULA_TEXT}</pre>
        </div>

        {!hasScrolledToEnd && (
          <p style={styles.hint}>Scroll to the end to continue.</p>
        )}

        <label style={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            disabled={!hasScrolledToEnd}
            style={styles.checkbox}
          />
          <span>I have read and agree to the terms above.</span>
        </label>

        <div style={styles.actions}>
          <button
            type="button"
            onClick={() => {
              // Declining closes the app rather than letting the user in.
              // Tauri exposes a window-close API; fall back to a no-op if
              // it isn't available in this build.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (window as any).__TAURI__?.window
                ?.getCurrentWindow?.()
                ?.close?.();
            }}
            style={styles.declineButton}
          >
            Decline and quit
          </button>
          <button
            type="button"
            onClick={handleAgree}
            disabled={!canAgree}
            style={{
              ...styles.agreeButton,
              ...(canAgree ? {} : styles.agreeButtonDisabled),
            }}
          >
            I agree
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(10, 11, 13, 0.72)",
    backdropFilter: "blur(2px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
  },
  card: {
    width: "min(560px, 90vw)",
    maxHeight: "85vh",
    background: "#17181c",
    border: "1px solid #2a2c33",
    borderRadius: 10,
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    color: "#e6e6e8",
  },
  header: {
    padding: "20px 24px 12px",
    borderBottom: "1px solid #23252b",
  },
  title: {
    margin: 0,
    fontSize: 17,
    fontWeight: 600,
    color: "#f2f2f3",
  },
  subtitle: {
    margin: "6px 0 0",
    fontSize: 13,
    color: "#9a9ca3",
  },
  textBox: {
    margin: "16px 24px",
    padding: "14px 16px",
    background: "#0f1013",
    border: "1px solid #23252b",
    borderRadius: 6,
    overflowY: "auto",
    flex: 1,
    minHeight: 220,
  },
  pre: {
    margin: 0,
    fontFamily:
      "ui-monospace, 'SF Mono', Consolas, 'Courier New', monospace",
    fontSize: 11.5,
    lineHeight: 1.6,
    color: "#c7c8cc",
    whiteSpace: "pre-wrap",
  },
  hint: {
    margin: "0 24px 8px",
    fontSize: 12,
    color: "#7d7f87",
  },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    margin: "4px 24px 16px",
    fontSize: 13,
    color: "#c7c8cc",
  },
  checkbox: {
    width: 15,
    height: 15,
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    padding: "14px 24px",
    borderTop: "1px solid #23252b",
  },
  declineButton: {
    padding: "8px 14px",
    borderRadius: 6,
    border: "1px solid #34363d",
    background: "transparent",
    color: "#c7c8cc",
    fontSize: 13,
    cursor: "pointer",
  },
  agreeButton: {
    padding: "8px 16px",
    borderRadius: 6,
    border: "none",
    background: "#4c8dff",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  agreeButtonDisabled: {
    background: "#2a3550",
    color: "#7c88a8",
    cursor: "not-allowed",
  },
};
