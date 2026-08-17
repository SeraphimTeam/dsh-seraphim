window.__ModuleLoader__.load({
  id: "dsh-seraphim",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");

    /* ------------------------------------------------------------------ *
     * Per-provider auth endpoints (unchanged from the four originals so
     * existing stored credentials and any in-flight flows keep working).
     * ------------------------------------------------------------------ */
    const PATHS = {
      "claude-code": {
        status: "/plugins/claude-code/auth/status",
        login: "/plugins/claude-code/auth/login",
        import: "/plugins/claude-code/auth/import",
        cancel: "/plugins/claude-code/auth/cancel",
        logout: "/plugins/claude-code/auth/logout",
        accounts: "/plugins/claude-code/auth/accounts",
        usage: "/plugins/claude-code/auth/usage",
      },
      freebuff: {
        status: "/plugins/freebuff/auth/status",
        login: "/plugins/freebuff/auth/login",
        logout: "/plugins/freebuff/auth/logout",
        token: "/plugins/freebuff/auth/token",
        accounts: "/plugins/freebuff/auth/accounts",
      },
      commandcode: {
        status: "/plugins/commandcode/auth/status",
        login: "/plugins/commandcode/auth/login",
        logout: "/plugins/commandcode/auth/logout",
        token: "/plugins/commandcode/auth/token",
        accounts: "/plugins/commandcode/auth/accounts",
        plans: "/plugins/commandcode/plans",
      },
      zed: {
        status: "/plugins/zed/auth/status",
        login: "/plugins/zed/auth/login",
        logout: "/plugins/zed/auth/logout",
        credentials: "/plugins/zed/auth/credentials",
        accounts: "/plugins/zed/auth/accounts",
      },
      codex: {
        status: "/plugins/codex/auth/status",
        login: "/plugins/codex/auth/login",
        cancel: "/plugins/codex/auth/cancel",
        logout: "/plugins/codex/auth/logout",
        accounts: "/plugins/codex/auth/accounts",
        usage: "/plugins/codex/auth/usage",
      },
    };

    /** Host route for the per-provider on/off flags (Seraphim tab switches). */
    const PROVIDER_FLAGS_PATH = "/plugins/seraphim/providers";

    const name = "dsh-seraphim-client";
    const inject = ["slots", "locale", "sessions", "modelDirectories", "settingsScope"];
    const SERAPHIM_SETTINGS_NS = "seraphim";
    const MODEL_SLOT = "conversation.input.model";
    const MODEL_SLOT_PRIORITY = -10; // lower numeric priority wins in DSH single-slot election

    async function jsonRequest(path, method = "GET", body) {
      const response = await fetch(path, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        credentials: "same-origin",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message =
          typeof value === "object" && value !== null && typeof value.error === "string"
            ? value.error
            : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return value;
    }

    const styles = {
      section: {
        boxSizing: "border-box",
        width: "100%",
        maxWidth: 720,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        paddingBottom: 24,
        color: "var(--dsw-alias-label-primary)",
      },
      hero: {
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "4px 2px 10px",
      },
      heroTitle: {
        margin: 0,
        fontSize: 17,
        lineHeight: "26px",
        fontWeight: 600,
        color: "var(--dsw-alias-label-primary)",
        display: "flex",
        alignItems: "center",
        gap: 8,
      },
      heroSub: {
        margin: 0,
        maxWidth: "64ch",
        fontSize: 13,
        lineHeight: "20px",
        color: "var(--dsw-alias-label-tertiary)",
      },
      heroMeta: {
        display: "flex",
        flexWrap: "wrap",
        gap: "6px 8px",
        marginTop: 4,
      },
      metaChip: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 22,
        padding: "0 10px",
        boxSizing: "border-box",
        borderRadius: 999,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-2)",
        fontSize: 12,
        lineHeight: "18px",
        color: "var(--dsw-alias-label-secondary)",
        whiteSpace: "nowrap",
      },
      metaChipDot: { width: 6, height: 6, borderRadius: "50%", flex: "0 0 auto" },
      card: {
        overflow: "hidden",
        boxSizing: "border-box",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 12,
        background: "var(--dsw-alias-bg-layer-1)",
      },
      header: {
        boxSizing: "border-box",
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 12,
        border: 0,
        padding: "13px 14px",
        background: "transparent",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
        transition: "background-color .14s ease",
      },
      monogram: {
        boxSizing: "border-box",
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 30,
        height: 30,
        borderRadius: 8,
        background: "var(--dsw-alias-bg-layer-3)",
        border: "1px solid var(--dsw-alias-border-l2)",
        overflow: "hidden",
      },
      logoImg: {
        display: "block",
        width: 22,
        height: 22,
        objectFit: "contain",
      },
      headText: { display: "flex", flex: 1, minWidth: 0, flexDirection: "column", gap: 2 },
      title: { fontSize: 14, lineHeight: "20px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      intro: {
        fontSize: 12,
        lineHeight: "18px",
        color: "var(--dsw-alias-label-tertiary)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        maxWidth: "48ch",
      },
      statusPill: {
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        flex: "0 0 auto",
        minHeight: 22,
        padding: "0 9px",
        borderRadius: 999,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-2)",
        fontSize: 12,
        lineHeight: "18px",
        color: "var(--dsw-alias-label-secondary)",
        whiteSpace: "nowrap",
      },
      statusDot: { width: 7, height: 7, borderRadius: "50%", flex: "0 0 auto" },
      chevron: {
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        color: "var(--dsw-alias-label-tertiary)",
        transition: "transform 150ms ease",
      },
      body: {
        boxSizing: "border-box",
        borderTop: "1px solid var(--dsw-alias-border-l1)",
        padding: "16px 16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      },
      block: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 },
      blockLabel: {
        fontSize: 12,
        lineHeight: "18px",
        fontWeight: 600,
        color: "var(--dsw-alias-label-secondary)",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      },
      hint: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      button: {
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 32,
        padding: "0 14px",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        background: "var(--dsw-alias-bg-layer-2)",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        fontSize: 13,
        lineHeight: "32px",
        cursor: "pointer",
        transition: "background-color .14s ease, border-color .14s ease",
      },
      buttonPrimary: {
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 32,
        padding: "0 14px",
        border: "1px solid var(--dsw-alias-button-primary-fill)",
        borderRadius: 8,
        background: "var(--dsw-alias-button-primary-fill)",
        color: "var(--dsw-alias-button-primary-dimmed, #fff)",
        font: "inherit",
        fontSize: 13,
        lineHeight: "32px",
        cursor: "pointer",
        transition: "background-color .14s ease, border-color .14s ease",
      },
      buttonDanger: {
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 32,
        padding: "0 14px",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        background: "transparent",
        color: "var(--dsw-alias-state-error-primary)",
        font: "inherit",
        fontSize: 13,
        lineHeight: "32px",
        cursor: "pointer",
      },
      actionRow: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" },
      error: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-error-primary)" },
      success: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-success-primary)" },
      warn: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-warn-primary)" },
      accountRow: {
        display: "flex",
        alignItems: "stretch",
        justifyContent: "space-between",
        gap: 12,
        padding: "9px 10px",
        borderRadius: 8,
        background: "var(--dsw-alias-bg-layer-2)",
        border: "1px solid var(--dsw-alias-border-l1)",
      },
      accountMain: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 },
      accountName: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
      accountText: {
        fontSize: 13,
        lineHeight: "20px",
        fontWeight: 500,
        color: "var(--dsw-alias-label-primary)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      accountSub: {
        fontSize: 11,
        lineHeight: "16px",
        color: "var(--dsw-alias-label-tertiary)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      quotaRow: { display: "flex", flexDirection: "column", gap: 4, marginTop: 4 },
      quotaLine: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
      quotaModel: {
        flex: "0 0 auto",
        minWidth: 64,
        fontSize: 11,
        lineHeight: "16px",
        color: "var(--dsw-alias-label-secondary)",
        fontVariantNumeric: "tabular-nums",
      },
      quotaTrack: {
        display: "block",
        flex: 1,
        height: 8,
        borderRadius: 4,
        background: "var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.08))",
        border: "1px solid var(--dsw-alias-border-l1)",
        overflow: "hidden",
        minWidth: 40,
        boxSizing: "border-box",
      },
      quotaFill: {
        display: "block",
        height: "100%",
        borderRadius: 4,
        background: "var(--dsw-alias-state-success-primary, #16825d)",
      },
      quotaCount: {
        flex: "0 0 auto",
        fontSize: 11,
        lineHeight: "16px",
        color: "var(--dsw-alias-label-tertiary)",
        fontVariantNumeric: "tabular-nums",
        minWidth: 48,
        textAlign: "right",
      },
      planBadge: {
        display: "inline-flex",
        alignItems: "center",
        flex: "0 0 auto",
        minHeight: 18,
        padding: "0 7px",
        boxSizing: "border-box",
        borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-3)",
        fontSize: 11,
        lineHeight: "18px",
        fontWeight: 600,
        color: "var(--dsw-alias-label-secondary)",
        whiteSpace: "nowrap",
      },
      planChip: {
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        minHeight: 28,
        padding: "0 12px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-2)",
        color: "var(--dsw-alias-label-secondary)",
        font: "inherit",
        fontSize: 12,
        lineHeight: "28px",
        cursor: "pointer",
        transition: "border-color .14s ease, background-color .14s ease, color .14s ease",
        userSelect: "none",
      },
      planChipOn: {
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        minHeight: 28,
        padding: "0 12px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-brand-primary)",
        background: "var(--dsw-alias-interactive-bg-hover-accent, var(--dsw-alias-bg-layer-2))",
        color: "var(--dsw-alias-brand-text, var(--dsw-alias-label-primary))",
        font: "inherit",
        fontSize: 12,
        lineHeight: "28px",
        cursor: "pointer",
        transition: "border-color .14s ease, background-color .14s ease, color .14s ease",
        userSelect: "none",
      },
      checkMark: { fontSize: 12, lineHeight: 1, color: "var(--dsw-alias-brand-primary)" },
      statusText: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
      // Switch styled after the Memory System plugin's toggle: small track,
      // tinted (not solid) checked state, accent-colored knob, On/Off label.
      switchRoot: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 32,
        padding: "0 1px",
        boxSizing: "border-box",
        color: "var(--dsw-alias-label-tertiary)",
        cursor: "pointer",
        fontSize: 9.5,
        lineHeight: 1,
        whiteSpace: "nowrap",
        userSelect: "none",
        transition: "color .15s ease",
      },
      switchRootOn: { color: "var(--dsw-alias-label-primary)" },
      switchTrack: {
        position: "relative",
        flex: "none",
        boxSizing: "border-box",
        width: 29,
        height: 17,
        borderRadius: 999,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-2)",
        transition: "border-color .18s ease, background-color .18s ease",
      },
      switchTrackOn: {
        borderColor: "color-mix(in srgb, var(--dsw-alias-brand-primary) 65%, var(--dsw-alias-border-l2))",
        background: "color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, var(--dsw-alias-bg-layer-2))",
      },
      switchKnob: {
        position: "absolute",
        top: 2,
        left: 2,
        width: 11,
        height: 11,
        borderRadius: "50%",
        background: "var(--dsw-alias-label-tertiary)",
        transition: "transform .2s cubic-bezier(.2,.8,.2,1), background-color .18s ease",
      },
      switchKnobOn: {
        background: "var(--dsw-alias-brand-primary)",
        transform: "translateX(12px)",
      },
      switchDisabled: { opacity: 0.48, cursor: "default" },
      preferenceRow: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "12px 14px",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 10,
        background: "var(--dsw-alias-bg-layer-1)",
      },
      preferenceCopy: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 },
      preferenceTitle: { fontSize: 13, lineHeight: "20px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      preferenceDescription: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      modelMenuRoot: { minWidth: 0, position: "relative" },
      modelTrigger: {
        minWidth: 0,
        maxWidth: 240,
        minHeight: 44,
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        background: "transparent",
        border: 0,
        borderRadius: 8,
        alignItems: "center",
        gap: 4,
        padding: "0 7px",
        font: "inherit",
        fontSize: 13,
        fontWeight: 500,
        lineHeight: "20px",
        display: "flex",
      },
      modelTriggerLabel: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" },
      modelTriggerEffort: { color: "var(--dsw-alias-label-tertiary)", flex: "none" },
      modelMenu: {
        zIndex: 20,
        border: "1px solid var(--dsw-alias-border-inverted)",
        background: "var(--dsw-specific-menu)",
        width: "min(560px, calc(100vw - 24px))",
        maxHeight: "min(440px, calc(100vh - 80px))",
        boxShadow: "var(--dsw-shadow-lv3)",
        color: "var(--dsw-alias-label-primary)",
        borderRadius: 12,
        gridTemplateColumns: "minmax(150px, .72fr) minmax(220px, 1.28fr)",
        display: "grid",
        position: "absolute",
        bottom: "calc(100% + 8px)",
        right: 0,
        overflow: "hidden",
      },
      modelPane: { minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" },
      modelPaneHeader: {
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 8,
        padding: "12px 12px 8px",
        borderBottom: "1px solid var(--dsw-alias-border-l1)",
      },
      modelPaneTitle: { fontSize: 12, lineHeight: "18px", fontWeight: 600, color: "var(--dsw-alias-label-secondary)" },
      modelPaneHint: { fontSize: 11, lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
      modelList: { minHeight: 0, overflowY: "auto", padding: 6, display: "flex", flexDirection: "column", gap: 2 },
      modelProviderGroup: { display: "flex", flexDirection: "column", gap: 2 },
      modelProviderGroupSpaced: { marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--dsw-alias-border-l1)" },
      modelProviderCategory: { padding: "2px 8px 4px", fontSize: 10.5, lineHeight: "16px", fontWeight: 600, color: "var(--dsw-alias-label-tertiary)" },
      modelProviderButton: {
        boxSizing: "border-box",
        minHeight: 44,
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "5px 8px 5px 10px",
        border: 0,
        borderRadius: 6,
        background: "transparent",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
      },
      modelProviderButtonActive: { background: "var(--dsw-alias-interactive-bg-hover)", boxShadow: "inset 2px 0 var(--dsw-alias-brand-primary)" },
      modelLogo: { width: 20, height: 20, flex: "0 0 auto", objectFit: "contain", borderRadius: 5 },
      modelItemCopy: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 },
      modelProviderName: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, lineHeight: "18px", fontWeight: 600 },
      modelProviderMeta: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
      modelOption: {
        boxSizing: "border-box",
        minHeight: 44,
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 8px",
        border: 0,
        borderRadius: 7,
        background: "transparent",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
      },
      modelOptionSelected: { background: "var(--dsw-alias-interactive-bg-active)" },
      modelName: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, lineHeight: "18px", fontWeight: 500 },
      modelDescription: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
      modelCheck: { flex: "0 0 auto", width: 18, color: "var(--dsw-alias-brand-primary)", textAlign: "center" },
      modelStatus: { padding: "12px", fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      modelError: { margin: 6, padding: "8px 9px", borderRadius: 7, background: "var(--dsw-alias-interactive-bg-hover-danger)", color: "var(--dsw-alias-state-error-primary)", fontSize: 12, lineHeight: "18px", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 },
      modelErrorAction: { minHeight: 32, padding: "0 10px", border: "1px solid currentColor", borderRadius: 6, background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" },
      modelEffort: { margin: 6, paddingTop: 8, borderTop: "1px solid var(--dsw-alias-border-l1)" },
      modelEffortLabel: { padding: "0 8px 5px", fontSize: 11, lineHeight: "16px", fontWeight: 600, color: "var(--dsw-alias-label-secondary)" },
    };

    const LOGOS = {
      "claude": "data:image/png;base64,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",
      "freebuff": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAE5klEQVR4nO2djVHjMBCFH5krwNeBUwGhAnId0AHpADqADhIqADqgA0gFCRU4HSQd6OYF+TA/R5wfS4r2fTM7YRywFO3zarVW8AnaUwC4AHAOYACg9MdEfFYAFgDmAKYAnvyxg0BHjwEsATgZjmUM7r3vdqbwjo/9QWTYawzGu0RqKqfS4CMX8VXbRAPO73I+shQBfasrPwFnuFQiwcmnOX+2b+IgkoerhbN6ldBrvHEj55ug9L7+EAHqpE/Yoc9oUEeAf4oQZriuI0DhizzRcY55CnBy0kxNREcwB+j3fHk3OoPB+wqlLJWHBmBd2u/52n50mk4fDodR+2KI816b4kDoCND8WXTKgAJIIt6en78HotPT06h9MUTJbOst80okASSr1Qr9fn/9KrqlWQiKxuc5vygKTQOWBHB5efnl2MVFEosTE8S+QeGqqnKfWS6X0fsFAxY9AoxGo2/X/ZwGtBwMQ1QFPj8/u//B92L3D/lbvMaHw6HbBH8ngUFyGVtac7+iAGwIYDQaubZcX1/Hvkpcxha+0bIsW139zRUB/yaBwXIZWvhGZ7OZ2xb+TQKD5TK0sA2Ox2O3K/f397EHy2Vo4Rq7ublx+8JzJDBoLiML0xCv3kPBKJLAwLlMrNsGmLztMudvgudUYoi0BXB1dbXO4LuCKwkuJxO4itwR2+FPyurdTyXeLoSgiiHiCyC04z/DthUREE4ARVGsnc6krMtQv0tEYNKpqICNPtxqSxhv23LDJvfv8ZXG27ap8/Lygul0ivl8jsVisX4Vb7QWQHPPXg7oyydvRN8QIuKy1RTAkN+cBo5hxw53FjPkv76+rqeCehoQ7+yd+T88PGx1d69rmJBOJpN135iodrR+dpnY4U7GJVjsZaAyf8QTQDMqhIwIcjzSiADfRYQuhcBQr91CSGcK+M50MwipW5iGmJQdCiadCQycy8TCNXZ7e7u383mOBAbNZWRhG+TVuyuMIgkMmMvMwjeqTaGwLQAmhtvcPeRKQrt/kI8AaFy+tUX3+JFXBKitTdWQV3/MPiJ/i9e4vhwK2wKg6evhsC2An6KA5n7kLwDadysCzf0IMvZJ7Ah6fHz8coybN0QYXIrTgO7rI8jYJ/GPIrmzuKqqDzuMtWkzDL2U9u3VKPwbEwDhps0a7uEXxgTQjAD64oZBATTDvrZthyOJJLBGj4wxLgBheAoQcfgF41RVlfRDqrquhygCGEcCMI4EYBwJwDgSgHEkAONIAMZRJdA4igDGkQCMIwEYRwIwjgRgHAnAOBKAcSQA40gAxpEAjCMBGEcCMI4EYBwJwDgSgHEkAONIAMaRAIwjARhHAjCOBGAcCcA4EoBxJADjSADGkQCMIwEYRwIwjgRgHAnAOBKAcSQA40gAxpEAjCMBGEcCMI4EYBwJwDgSgHEkAONQAKvYnRDRWFEAi3jti8gsKID3JzYKa8wpAD2m2y5T/rNoPrG58q/CFr/rJPAxdk9EcB7o+/qZZKWPAsIO/ToJhF8J3EXukAjHXb36az6VkDnAzEcDkS90/Fld/2lWAnngj+oC2Tv/z6bi38DnA3yotAzZjEHlfduKOimM3WkZDub8rad25gQTOQHHLsLJvjWe0q8ZY38QGVqPwdI7fuNVv82zyamiCwBDAKf+5KoepgGTOiZ4c5Z3ATy1vcv7F3dQ1ARKOXr5AAAAAElFTkSuQmCC",
      "commandcode": "data:image/png;base64,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",
      "zed": "data:image/png;base64,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",
      "codex": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAYFBMVEX///8AAADz8/O/v7+qqqq4uLj4+Pjo6Oh+fn7h4eHExMSwsLDKysrZ2dmioqImJiYrKytpaWmNjY3T09NMTExCQkJUVFR2dnYbGxszMzOHh4cODg5cXFwhISGUlJQ5OTkNyEhkAAADGElEQVRYhe1X2XbqMAzMQuw4KxBCCKHl///y2pJl5AVKOee+VS/E4JloGckmy/7sP5rqqnJSn6L765aj1f0HcHnLmR2K3+LLPLAuE7LrpneJKnxvq6RU1RkXSPS1TG/gO4jcvU2dPWdO8ie8MNsaFs8YxLP7gaCGmMn6E4Dmoen7bofO1C/xhd5xdYsFEHvnkIJkHF8RDHpDwZ61Dfz3Nvc8jE0rYMGnDoOvhb8BGJ7CO+NzaZ4kxnsmLUuX/Tp0isHvADJbCz94qWNfrCumTPsk/mrrVJCj7j3fXgGP+jHVZIecEezYpupCv9whe0o/VTEeKnbdMQL8Xs2AXVfXWCaG7wgPDVTCByewSshb/Aqha0pMG5Y3IEAlbPg+UcPq0swJgsEKzCNobBvsqQcfjRWFMFqXOQGbKjdSAXE2AV5R0TgBeF92WAOn/yGWd4ZlVwmC4QExeQQrDnxlTWvokkUE1AYCJbZSKmBk+VKqSZ2cgG1R6MTBpsLsmkOCMSLgG4Ls17ntOTIt700QgUwT4GzaGlp7LpQ8iVuZJGgLrKu0b8z5eJVUKAl7TkUbE+henEy/V5QUL4aZANMXUiQJYEwAgdiC0WgqY2fpQAlLEAgiyPZhP6wPfVIHBmX0PIgJeq7wHmebLySf4MKmPxoMsYUmehVL2SNITaWgS45+MwUEQyRm3am4b0+nhnRDEjvbI9CfXwGeRi9r/mlvOZuwjMc8cTZofd9t6LbCw8VF5ROYG8AW4g3B6vzQu5oLK4VHYAdwIgTTUDgv8hl752zDYQQDyCRxxlfUH9NM2VgpoSQkQb8sMd5tMlybKxwmw6zajI7MZzeEEZKAdmTneoPFeJy59ydXrYG/VJAm6ZyH6IxWlufXC7MxILen0WhBenV7Crfno6dwPt1tBC8vadB1BzeqbPCuw2CWijTUGk6C29D1fXlE+Olx2WZT56m5hrA2MsG1SQGHpk4ewcn1rADv3rn7TwuewCPGc257felucBE3QNqE6vrCXru5vXNX94zGK9rv/3hoU7Vrn0/++iBH2Zbdx+g/e8f+AUjCHMA9oP1SAAAAAElFTkSuQmCC",
    };

    /* ------------------------------------------------------------------ *
     * Helpers
     * ------------------------------------------------------------------ */
    function shortModel(id) {
      const last = String(id).split("/").pop();
      const map = {
        "deepseek-v4-flash": "V4 Flash",
        "mimo-v2.5": "MiMo",
        "deepseek-v4-pro": "V4 Pro",
        "gpt-5.6-luna": "Luna",
        "minimax-m3": "MiniMax",
        "muse-spark-1.2-contributor": "Muse",
        "claude-fable-5": "Fable",
        "glm-5.2": "GLM",
        "laguna-s-2.1": "Laguna",
        "kimi-k3-eco": "Kimi",
      };
      return map[last] || last;
    }

    function formatExpiry(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "";
      try {
        return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      } catch {
        return "";
      }
    }

    function planLabel(plan) {
      if (!plan) return "";
      if (plan === "zed_pro") return "Pro";
      if (plan === "zed_pro_trial") return "Pro trial";
      if (plan === "zed_free") return "Free";
      if (plan === "zed_student" || plan === "token_based_zed_student") return "Student";
      if (plan === "zed_business") return "Business";
      return plan;
    }

    function percent(used, limit) {
      if (!Number.isFinite(limit) || limit <= 0) return 0;
      return Math.max(0, Math.min(100, (used / limit) * 100));
    }

    function clampPercent(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return 0;
      return Math.max(0, Math.min(100, Math.round(value)));
    }

    function statusTone(status, signedIn) {
      if (status === "error" || status === "expired") return "var(--dsw-alias-state-error-primary)";
      if (status === "pending") return "var(--dsw-alias-state-warn-primary)";
      if (signedIn) return "var(--dsw-alias-state-success-primary)";
      return "var(--dsw-alias-label-tertiary)";
    }

    function statusCopy(status, signedIn, t) {
      if (status === "pending") return t("waiting");
      if (status === "error") return t("errorStatus");
      if (status === "expired") return t("expired");
      if (signedIn) return t("signedIn");
      return t("signedOut");
    }

    /* ------------------------------------------------------------------ *
     * Shared building blocks
     * ------------------------------------------------------------------ */
    function Chevron({ open }) {
      return jsx("span", {
        "aria-hidden": "true",
        style: { ...styles.chevron, transform: open ? "rotate(180deg)" : "none" },
        children: jsx("svg", {
          width: 16,
          height: 16,
          viewBox: "0 0 16 16",
          fill: "none",
          children: jsx("path", {
            d: "M4 6l4 4 4-4",
            stroke: "currentColor",
            strokeWidth: 1.5,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          }),
        }),
      });
    }

    function useSeraphimSettings(settings) {
      const snapshot = react.useSyncExternalStore(
        (listener) => settings?.subscribe?.(listener) ?? (() => {}),
        () => settings?.getSnapshot?.() ?? ({ status: "unavailable", value: undefined, writable: false }),
        () => settings?.getSnapshot?.() ?? ({ status: "unavailable", value: undefined, writable: false }),
      );
      const enabled = snapshot.status === "ready" && snapshot.value?.betterModelSelection === true;
      const setEnabled = react.useCallback((next) => settings?.set?.("betterModelSelection", next), [settings]);
      return { snapshot, enabled, setEnabled };
    }

    function BetterModelSelectionRow({ t, settings }) {
      const { snapshot, enabled, setEnabled } = useSeraphimSettings(settings);
      const [error, setError] = react.useState("");
      const [pendingWrite, setPendingWrite] = react.useState(false);
      const unavailable = snapshot.status === "unavailable" || snapshot.status === "loading";
      const pending = snapshot.status === "loading" || pendingWrite;
      const toggle = () => {
        if (unavailable || pending || snapshot.writable === false) return;
        const next = !enabled;
        setError("");
        setPendingWrite(true);
        let result;
        try {
          result = setEnabled(next);
        } catch (failure) {
          setPendingWrite(false);
          setError(failure instanceof Error ? failure.message : String(failure));
          return;
        }
        if (result === undefined) {
          setPendingWrite(false);
          setError(t("betterModelSelection.saveFailed"));
          return;
        }
        Promise.resolve(result).then(() => {
          const latest = settings?.getSnapshot?.();
          const persisted = latest?.status === "ready" && latest.value?.betterModelSelection === next;
          setPendingWrite(false);
          setError(persisted ? "" : t("betterModelSelection.saveFailed"));
        }, (failure) => {
          setPendingWrite(false);
          setError(failure instanceof Error ? failure.message : String(failure));
        });
      };
      return jsxs("div", {
        style: styles.preferenceRow,
        children: [
          jsxs("div", {
            style: styles.preferenceCopy,
            children: [
              jsx("span", { style: styles.preferenceTitle, children: t("betterModelSelection.title") }),
              jsx("span", { style: styles.preferenceDescription, children: t("betterModelSelection.description") }),
              error ? jsx("span", { role: "alert", style: styles.error, children: error }) : null,
            ],
          }),
          jsx("span", {
            role: "switch",
            tabIndex: unavailable || pending || snapshot.writable === false ? -1 : 0,
            "aria-checked": enabled,
            "aria-disabled": unavailable || pending || snapshot.writable === false,
            "aria-label": t("betterModelSelection.aria"),
            className: "dsh-seraphim-card-switch",
            style: {
              ...styles.switchRoot,
              ...(enabled ? styles.switchRootOn : {}),
              ...(unavailable || pending || snapshot.writable === false ? styles.switchDisabled : {}),
            },
            onClick: toggle,
            onKeyDown: (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggle();
              }
            },
            children: [
              jsx("span", { "aria-hidden": "true", className: "dsh-seraphim-card-switch-track", style: { ...styles.switchTrack, ...(enabled ? styles.switchTrackOn : {}) }, children: jsx("i", { style: { ...styles.switchKnob, ...(enabled ? styles.switchKnobOn : {}) } }) }),
              jsx("span", { children: pending ? t("betterModelSelection.loading") : enabled ? t("betterModelSelection.on") : t("betterModelSelection.off") }),
            ],
          }),
        ],
      });
    }

    const SERAPHIM_PROVIDER_IDS = new Set(["claude-code", "freebuff", "commandcode", "zed", "codex"]);

    function providerLogo(providerId) {
      const aliases = {
        "claude-code": "claude",
        freebuff: "freebuff",
        commandcode: "commandcode",
        zed: "zed",
        codex: "codex",
      };
      return LOGOS[aliases[providerId] ?? providerId];
    }

    function ModelCheck() {
      return jsx("span", { "aria-hidden": "true", children: "✓" });
    }

    function BetterModelSelect({ locked, available, directory, load, select, t, copy = t }) {
      const state = react.useSyncExternalStore((listener) => directory.subscribe(listener), () => directory.getSnapshot());
      const [open, setOpen] = react.useState(false);
      const [providerId, setProviderId] = react.useState(null);
      const [selectionError, setSelectionError] = react.useState("");
      const rootRef = react.useRef(null);
      const triggerRef = react.useRef(null);
      const itemRefs = react.useRef([]);
      const id = react.useId();
      const currentGroup = state.groups.find((group) => group.id === state.current?.provider);
      const currentModel = currentGroup?.models.find((model) => model.id === state.current?.model);
      const activeProvider = state.groups.find((group) => group.id === (providerId ?? state.current?.provider)) ?? state.groups[0];
      const effort = currentModel?.reasoning;
      const effectiveEffort = state.current?.reasoningEffort ?? effort?.defaultEffort;
      const busy = state.status === "selecting";
      const modelLabel = currentModel?.name ?? copy("selectModel");
      const effortLabel = effort === undefined ? "" : effectiveEffort === undefined ? copy("defaultEffort") : effort.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort;
      const providerSections = [
        { id: "dsh", label: copy("dshProviders"), groups: state.groups.filter((group) => !SERAPHIM_PROVIDER_IDS.has(group.id)), showLogo: false },
        { id: "seraphim", label: copy("seraphimProviders"), groups: state.groups.filter((group) => SERAPHIM_PROVIDER_IDS.has(group.id)), showLogo: true },
      ].filter((section) => section.groups.length > 0);

      react.useEffect(() => {
        if (available) load();
      }, [available, load]);
      react.useEffect(() => {
        if (!open) return undefined;
        const closeOutside = (event) => {
          if (!rootRef.current?.contains(event.target)) {
            setOpen(false);
            setProviderId(null);
          }
        };
        document.addEventListener("mousedown", closeOutside);
        return () => document.removeEventListener("mousedown", closeOutside);
      }, [open]);
      if (!available) return null;
      const close = (restoreFocus = false) => {
        setOpen(false);
        setProviderId(null);
        setSelectionError("");
        if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
      };
      const choose = (selection) => {
        setSelectionError("");
        select(selection).then((accepted) => {
          if (accepted) close(true);
          else setSelectionError(directory.getSnapshot().error ?? copy("selectionFailed"));
        });
      };
      const retry = () => {
        setSelectionError("");
        load();
      };
      const chooseEffort = (nextEffort) => {
        if (state.current === null) return;
        choose({ provider: state.current.provider, model: state.current.model, ...(nextEffort === undefined ? {} : { reasoningEffort: nextEffort }) });
      };
      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (providerId !== null) setProviderId(null);
          else close(true);
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const items = itemRefs.current.filter(Boolean);
        const current = items.indexOf(document.activeElement);
        if (items.length === 0) return;
        event.preventDefault();
        const start = current < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : current + (event.key === "ArrowDown" ? 1 : -1);
        items[(start + items.length) % items.length]?.focus();
      };
      itemRefs.current = [];
      const itemRef = (node) => itemRefs.current.push(node);
      return jsxs("div", {
        ref: rootRef,
        className: "dsh-seraphim-model-menu-root",
        style: styles.modelMenuRoot,
        onKeyDown,
        children: [
          jsxs("button", {
            ref: triggerRef,
            type: "button",
            disabled: locked || busy,
            className: "dsh-seraphim-model-trigger",
            style: styles.modelTrigger,
            "aria-haspopup": "dialog",
            "aria-expanded": open,
            "aria-controls": open ? `${id}-menu` : undefined,
            "aria-label": effortLabel ? `${modelLabel}, ${effortLabel}` : modelLabel,
            title: effortLabel ? `${modelLabel} · ${effortLabel}` : modelLabel,
            onClick: () => {
              if (open) close();
              else {
                setOpen(true);
                setProviderId(state.current?.provider ?? null);
                load();
              }
            },
            children: [
              jsx("span", { style: styles.modelTriggerLabel, children: modelLabel }),
              effortLabel ? jsx("span", { style: styles.modelTriggerEffort, children: `· ${effortLabel}` }) : null,
              jsx("span", { "aria-hidden": "true", children: open ? "▴" : "▾" }),
            ],
          }),
          open
            ? jsxs("div", {
                id: `${id}-menu`,
                className: "dsh-seraphim-model-menu",
                role: "dialog",
                "aria-label": copy("menuAria"),
                "aria-busy": state.status === "loading" || busy,
                style: styles.modelMenu,
                children: [
                  jsxs("div", {
                    style: { ...styles.modelPane, gridColumn: "1", minWidth: 170 },
                    children: [
                      jsxs("div", { style: styles.modelPaneHeader, children: [jsx("span", { style: styles.modelPaneTitle, children: copy("providers") }), jsx("span", { style: styles.modelPaneHint, children: state.groups.length })] }),
                      state.status === "loading" && state.groups.length === 0
                        ? jsx("div", { role: "status", style: styles.modelStatus, children: copy("loading") })
                        : state.groups.length === 0
                          ? jsx("div", { role: "status", style: styles.modelStatus, children: copy("noProviders") })
                          : jsx("div", { style: styles.modelList, children: providerSections.map((section, sectionIndex) => jsxs("div", {
                              style: { ...styles.modelProviderGroup, ...(sectionIndex > 0 ? styles.modelProviderGroupSpaced : {}) },
                              children: [
                                jsx("div", { style: styles.modelProviderCategory, children: section.label }),
                                ...section.groups.map((group) => {
                                  const active = activeProvider?.id === group.id;
                                  const logo = section.showLogo ? providerLogo(group.id) : undefined;
                                  return jsxs("button", {
                                    ref: itemRef,
                                    type: "button",
                                    style: { ...styles.modelProviderButton, ...(active ? styles.modelProviderButtonActive : {}) },
                                    "aria-pressed": active,
                                    onClick: () => setProviderId(group.id),
                                    children: [logo ? jsx("img", { src: logo, alt: "", style: styles.modelLogo }) : null, jsxs("span", { style: styles.modelItemCopy, children: [jsx("span", { style: styles.modelProviderName, children: group.name }), jsx("span", { style: styles.modelProviderMeta, children: `${group.models.length} ${copy("models")}` })] })],
                                  }, group.id);
                                }),
                              ],
                            }, section.id)) }),
                    ],
                  }),
                  jsxs("div", {
                    style: { ...styles.modelPane, gridColumn: "2", borderLeft: "1px solid var(--dsw-alias-border-l1)" },
                    children: [
                      jsxs("div", { style: styles.modelPaneHeader, children: [jsx("span", { style: styles.modelPaneTitle, children: activeProvider?.name ?? copy("models") }), jsx("span", { style: styles.modelPaneHint, children: copy("chooseModel") })] }),
                      activeProvider === undefined
                        ? state.error !== null
                          ? jsxs("div", { role: "alert", style: styles.modelError, children: [jsx("span", { children: state.error }), jsx("button", { type: "button", style: styles.modelErrorAction, onClick: retry, children: copy("retry") })] })
                          : jsx("div", { role: "status", style: styles.modelStatus, children: copy("chooseProvider") })
                        : jsxs("div", {
                              style: styles.modelList,
                              children: [
                                state.error !== null
                                  ? jsxs("div", { role: "alert", style: styles.modelError, children: [jsx("span", { children: state.error }), jsx("button", { type: "button", style: styles.modelErrorAction, onClick: retry, children: copy("retry") })] })
                                  : null,
                                selectionError ? jsx("div", { role: "alert", style: styles.modelError, children: selectionError }) : null,
                                activeProvider.models.length === 0
                                  ? jsx("div", { role: "status", style: styles.modelStatus, children: copy("noModels") })
                                  : null,
                                activeProvider.models.map((model) => {
                                  const selected = state.current?.provider === activeProvider.id && state.current?.model === model.id;
                                  const reasoning = model.reasoning;
                                  return jsxs("button", {
                                    ref: itemRef,
                                    type: "button",
                                    style: { ...styles.modelOption, ...(selected ? styles.modelOptionSelected : {}) },
                                    disabled: busy,
                                    onClick: () => choose({ provider: activeProvider.id, model: model.id, ...(reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: reasoning.defaultEffort }) }),
                                    children: [jsxs("span", { style: styles.modelItemCopy, children: [jsx("span", { style: styles.modelName, children: model.name }), model.description ? jsx("span", { style: styles.modelDescription, children: model.description }) : null] }), jsx("span", { style: styles.modelCheck, children: selected ? jsx(ModelCheck, {}) : null })],
                                  }, `${activeProvider.id}:${model.id}`);
                                }),
                                effort && selectedCurrentModel(state, activeProvider)
                                  ? jsx("div", { style: styles.modelEffort, children: jsxs("div", { children: [jsx("div", { style: styles.modelEffortLabel, children: copy("effort") }), jsx("div", { style: styles.modelList, children: [...(effort.defaultEffort === undefined ? [undefined] : []), ...effort.efforts.map((level) => level.id)].map((level) => jsx("button", { ref: itemRef, type: "button", style: { ...styles.modelOption, ...(effectiveEffort === level ? styles.modelOptionSelected : {}) }, disabled: busy, onClick: () => chooseEffort(level), children: [jsx("span", { style: styles.modelName, children: level === undefined ? copy("defaultEffort") : effort.efforts.find((candidate) => candidate.id === level)?.name ?? level }), jsx("span", { style: styles.modelCheck, children: effectiveEffort === level ? jsx(ModelCheck, {}) : null })] }, level ?? "default") ) })] }) }) : null,
                              ],
                            }),
                    ],
                  }),
                ],
              })
            : null,
        ],
      });
    }

    function selectedCurrentModel(state, group) {
      return state.current?.provider === group.id && state.current?.model !== undefined;
    }

    function StatusPill({ tone, label }) {
      return jsxs("span", {
        style: styles.statusPill,
        children: [
          jsx("span", { "aria-hidden": "true", style: { ...styles.statusDot, background: tone } }),
          jsx("span", { children: label }),
        ],
      });
    }

    function CardShell({ open, onToggle, logo, logoBg, title, intro, pill, switchProps, children }) {
      return jsxs("div", {
        style: styles.card,
        children: [
          jsxs("button", {
            type: "button",
            className: "dsh-seraphim-card-header",
            style: styles.header,
            "aria-expanded": open,
            onClick: onToggle,
            children: [
              jsx("span", { "aria-hidden": "true", style: { ...styles.monogram, ...(logoBg ? { background: logoBg } : {}) }, children: logo ? jsx("img", { src: logo, alt: "", style: styles.logoImg }) : null }),
              jsxs("span", {
                style: styles.headText,
                children: [
                  jsx("span", { style: styles.title, children: title }),
                  jsx("span", { style: styles.intro, children: intro }),
                ],
              }),
              pill ? jsx(StatusPill, { tone: pill.tone, label: pill.label }) : null,
              switchProps
                ? jsxs("span", {
                    role: "switch",
                    "aria-checked": switchProps.checked,
                    "aria-label": `${title} — click to ${switchProps.checked ? "disable" : "enable"}`,
                    tabIndex: 0,
                    title: `${title} — click to ${switchProps.checked ? "disable" : "enable"}`,
                    className: "dsh-seraphim-card-switch",
                    style: {
                      ...styles.switchRoot,
                      ...(switchProps.checked ? styles.switchRootOn : {}),
                      ...(switchProps.disabled ? styles.switchDisabled : {}),
                    },
                    onClick: (event) => {
                      event.stopPropagation();
                      if (switchProps.disabled !== true) switchProps.onChange(!switchProps.checked);
                    },
                    onKeyDown: (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        if (switchProps.disabled !== true) switchProps.onChange(!switchProps.checked);
                      }
                    },
                    children: [
                      jsxs("span", {
                        "aria-hidden": "true",
                        className: "dsh-seraphim-card-switch-track",
                        style: { ...styles.switchTrack, ...(switchProps.checked ? styles.switchTrackOn : {}) },
                        children: jsx("i", { style: { ...styles.switchKnob, ...(switchProps.checked ? styles.switchKnobOn : {}) } }),
                      }),
                      jsx("span", { children: switchProps.checked ? "On" : "Off" }),
                    ],
                  })
                : null,
              jsx(Chevron, { open }),
            ],
          }),
          open ? jsx("div", { style: styles.body, children }) : null,
        ],
      });
    }

    function Feedback({ kind, children }) {
      if (kind === "saved") return jsx("p", { role: "status", style: styles.success, children });
      if (kind === "error") return jsx("p", { role: "alert", style: styles.error, children });
      return null;
    }

    function usePolling(refresh, pending) {
      react.useEffect(() => {
        if (pending !== true) return undefined;
        const interval = window.setInterval(refresh, 3000);
        return () => window.clearInterval(interval);
      }, [pending, refresh]);
    }

    /* ------------------------------------------------------------------ *
     * Claude Code card (sign in / import / cancel / sign out)
     * ------------------------------------------------------------------ */
    function ClaudeCodeCard({ t, enabled, onToggleEnabled }) {
      const [open, setOpen] = react.useState(false);
      const [auth, setAuth] = react.useState({ status: "signed_out", signedIn: false, pending: false });
      const [accounts, setAccounts] = react.useState([]);
      const [usage, setUsage] = react.useState(undefined);
      const [busy, setBusy] = react.useState(false);
      const [feedback, setFeedback] = react.useState("idle");
      const [errorMessage, setErrorMessage] = react.useState("");

      const refresh = react.useCallback(async () => {
        try {
          const [status, acc] = await Promise.all([
            jsonRequest(PATHS["claude-code"].status),
            jsonRequest(PATHS["claude-code"].accounts),
          ]);
          setAuth(status && typeof status === "object" ? status : { status: "signed_out", signedIn: false, pending: false });
          setAccounts(Array.isArray(acc?.accounts) ? acc.accounts : []);
          if (typeof status?.error === "string") setErrorMessage(status.error);
        } catch (error) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }, []);

      const refreshUsage = react.useCallback(async () => {
        try {
          const result = await jsonRequest(PATHS["claude-code"].usage);
          setUsage(Array.isArray(result?.usage) ? result.usage : undefined);
        } catch {
          // usage is best-effort; keep the last value
        }
      }, []);

      react.useEffect(() => { refresh(); }, [refresh]);
      usePolling(refresh, auth.pending === true);
      react.useEffect(() => {
        if (auth.signedIn !== true) { setUsage(undefined); return undefined; }
        refreshUsage();
        const timer = setInterval(refreshUsage, 60000);
        return () => clearInterval(timer);
      }, [auth.signedIn, refreshUsage]);

      const run = async (action, onSaved) => {
        setBusy(true);
        setErrorMessage("");
        setFeedback("idle");
        try {
          const result = await action();
          if (typeof result?.url === "string") window.open(result.url, "_blank", "noopener");
          await refresh();
          if (onSaved) setFeedback("saved");
        } catch (error) {
          setFeedback("error");
          setErrorMessage(error instanceof Error ? error.message : String(error));
          await refresh();
        } finally {
          setBusy(false);
        }
      };

      const addAccount = () => run(() => jsonRequest(PATHS["claude-code"].login, "POST"));
      const importLogin = () => run(() => jsonRequest(PATHS["claude-code"].import, "POST"));
      const cancel = () => run(() => jsonRequest(PATHS["claude-code"].cancel, "POST"));
      const signOut = () => run(() => jsonRequest(PATHS["claude-code"].logout, "POST"), true);
      const removeAccount = (index) => run(() => jsonRequest(PATHS["claude-code"].accounts, "DELETE", { index }), true);
      const waiting = auth.pending === true;
      const signedIn = auth.signedIn === true;

      const pill = {
        tone: statusTone(auth.status, signedIn),
        label: statusCopy(auth.status, signedIn, t),
      };

      const usageByIndex = (index) => (Array.isArray(usage) ? usage.find((entry) => entry.index === index) : undefined);
      const usageBars = (entry) => {
        const windows = [];
        if (entry.usage?.fiveHour) {
          const u = entry.usage.fiveHour;
          windows.push({ key: "fiveHour", label: t("window5h"), percent: clampPercent(u.utilization) });
        }
        if (entry.usage?.sevenDay) {
          const u = entry.usage.sevenDay;
          windows.push({ key: "sevenDay", label: t("windowWeekly"), percent: clampPercent(u.utilization), reset: u.resetsAt });
        }
        if (windows.length === 0) return null;
        return jsxs("div", {
          style: { display: "flex", flexDirection: "column", gap: 4 },
          children: windows.map((window) =>
            jsxs("div", {
              key: window.key,
              style: styles.quotaLine,
              children: [
                jsx("span", { style: styles.quotaModel, children: window.label }),
                jsx("span", { style: styles.quotaTrack, children: jsx("span", { style: { ...styles.quotaFill, width: `${window.percent}%` } }) }),
                jsx("span", { style: styles.quotaCount, children: `${window.percent}%` }),
              ],
            }),
          ),
        });
      };

      return jsx(CardShell, {
        open,
        onToggle: () => setOpen(!open),
        logo: LOGOS.claude,
        title: t("title"),
        intro: t("intro"),
        pill,
        switchProps: { checked: enabled === true, onChange: onToggleEnabled },
        children: [
          jsxs("div", {
            style: styles.block,
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
                children: [
                  jsx("span", { style: styles.blockLabel, children: t("accounts") }),
                  waiting
                    ? jsx("button", { type: "button", style: styles.button, disabled: busy, onClick: cancel, children: busy ? t("working") : t("cancel") })
                    : jsx("button", { type: "button", style: styles.buttonPrimary, disabled: busy, onClick: addAccount, children: t("addAccount") }),
                ],
              }),
              waiting
                ? jsx("p", { role: "status", style: styles.statusText, children: t("waiting") })
                : accounts.length > 0
                  ? jsx("div", {
                      style: { display: "flex", flexDirection: "column", gap: 6 },
                      children: accounts.map((account) =>
                        jsxs("div", {
                          key: account.index,
                          style: styles.accountRow,
                          children: [
                            jsxs("div", {
                              style: styles.accountMain,
                              children: [
                                jsxs("div", {
                                  style: styles.accountName,
                                  children: [
                                    jsx("span", { style: styles.accountText, children: account.source === "import" ? t("importedAccount") : t("oauthAccount") }),
                                    account.subscriptionType
                                      ? jsx("span", { style: styles.planBadge, children: account.subscriptionType })
                                      : null,
                                  ],
                                }),
                                jsx("span", { style: styles.accountSub, children: [
                                  [account.rateLimitTier, account.expiresAt ? formatExpiry(account.expiresAt) : undefined]
                                    .filter(Boolean)
                                    .join(" - "),
                                ] }),
                                usageByIndex(account.index)
                                  ? jsx("div", { style: styles.quotaRow, children: usageBars(usageByIndex(account.index)) })
                                  : null,
                              ],
                            }),
                            jsx("button", { type: "button", style: { ...styles.button, alignSelf: "center" }, disabled: busy, onClick: () => removeAccount(account.index), children: t("remove") }),
                          ],
                        }),
                      ),
                    })
                  : jsx("p", { style: styles.hint, children: t("signedOutHelp") }),
            ],
          }),
          signedIn
            ? jsx("div", {
                style: { ...styles.actionRow, paddingTop: 12, borderTop: "1px solid var(--dsw-alias-border-l1)" },
                children: [
                  jsx("button", { type: "button", style: styles.button, disabled: busy, onClick: importLogin, children: t("importLogin") }),
                  jsx("button", { type: "button", style: styles.buttonDanger, disabled: busy, onClick: signOut, children: busy ? t("working") : t("signOut") }),
                ],
              })
            : null,
          jsx(Feedback, { kind: feedback, children: t("saved") }),
          feedback === "error" && errorMessage
            ? jsx("p", { role: "alert", style: styles.error, children: errorMessage })
            : null,
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * FreeBuff card (accounts + quota bars)
     * ------------------------------------------------------------------ */
    function QuotaBars({ quota, t }) {
      if (!Array.isArray(quota) || quota.length === 0) return null;
      return jsx("div", {
        style: styles.quotaRow,
        children: quota.map((q) => {
          const used = Number(q.used) || 0;
          const limit = Number(q.limit) || 0;
          const remaining = 100 - percent(used, limit);
          const label = shortModel(q.model);
          return jsxs("div", {
            key: String(q.model),
            style: styles.quotaLine,
            children: [
              jsx("span", { style: styles.quotaModel, children: label }),
              jsx("span", {
                style: styles.quotaTrack,
                role: "progressbar",
                "aria-label": label,
                "aria-valuemin": 0,
                "aria-valuemax": 100,
                "aria-valuenow": remaining,
                children: jsx("span", { style: { ...styles.quotaFill, width: `${remaining}%` } }),
              }),
              jsx("span", { style: styles.quotaCount, children: `${Math.round(remaining)}% ${t("remaining")}` }),
            ],
          });
        }),
      });
    }

    function FreeBuffCard({ t, enabled, onToggleEnabled }) {
      const [open, setOpen] = react.useState(false);
      const [auth, setAuth] = react.useState({ status: "loading" });
      const [accounts, setAccounts] = react.useState([]);
      const [busy, setBusy] = react.useState(false);
      const [feedback, setFeedback] = react.useState("idle");
      const [errorMessage, setErrorMessage] = react.useState("");

      const refreshAuth = react.useCallback(async () => {
        try {
          const [status, acc] = await Promise.all([jsonRequest(PATHS.freebuff.status), jsonRequest(PATHS.freebuff.accounts)]);
          setAuth(status);
          setAccounts(Array.isArray(acc?.accounts) ? acc.accounts : []);
        } catch {
          setAuth({ status: "error" });
        }
      }, []);

      react.useEffect(() => { refreshAuth(); }, [refreshAuth]);
      usePolling(refreshAuth, auth.pending === true);

      const addAccount = async () => {
        setBusy(true);
        setFeedback("idle");
        setErrorMessage("");
        try {
          const result = await jsonRequest(PATHS.freebuff.login, "POST");
          if (typeof result?.url === "string") window.open(result.url, "_blank", "noopener");
          await refreshAuth();
        } catch (error) {
          setFeedback("error");
          setErrorMessage(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      };

      const removeAccount = async (index) => {
        setBusy(true);
        setFeedback("idle");
        setErrorMessage("");
        try {
          await jsonRequest(PATHS.freebuff.accounts, "DELETE", { index });
          await refreshAuth();
        } catch (error) {
          setFeedback("error");
          setErrorMessage(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      };

      const waiting = auth.pending === true;
      const signedIn = auth.signedIn === true;
      const pill = {
        tone: statusTone(auth.status, signedIn),
        label: statusCopy(auth.status, signedIn, t),
      };

      return jsx(CardShell, {
        open,
        onToggle: () => setOpen(!open),
        logo: LOGOS.freebuff,
        logoBg: "#ffffff",
        title: t("title"),
        intro: t("intro"),
        pill,
        switchProps: { checked: enabled === true, onChange: onToggleEnabled },
        children: [
          jsxs("div", {
            style: styles.block,
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
                children: [
                  jsx("span", { style: styles.blockLabel, children: t("accounts") }),
                  jsx("button", { type: "button", style: styles.buttonPrimary, disabled: busy || waiting, onClick: addAccount, children: t("addAccount") }),
                ],
              }),
              waiting
                ? jsx("p", { role: "status", style: styles.statusText, children: t("waiting") })
                : accounts.length > 0
                  ? jsx("div", {
                      style: { display: "flex", flexDirection: "column", gap: 6 },
                      children: accounts.map((account) =>
                        jsxs("div", {
                          key: account.index,
                          style: styles.accountRow,
                          children: [
                            jsxs("div", {
                              style: styles.accountMain,
                              children: [
                                jsxs("div", {
                                  style: styles.accountName,
                                  children: [
                                    jsx("span", { style: styles.accountText, children: account.email }),
                                    account.tier === "limited"
                                      ? jsx("span", { style: styles.planBadge, children: "limited" })
                                      : account.tier === "full"
                                        ? jsx("span", { style: styles.planBadge, children: "full" })
                                        : null,
                                  ],
                                }),
                                jsx(QuotaBars, { quota: account.quota, t }),
                              ],
                            }),
                            jsx("button", { type: "button", style: { ...styles.button, alignSelf: "center" }, disabled: busy, onClick: () => removeAccount(account.index), children: t("remove") }),
                          ],
                        }),
                      ),
                    })
                  : jsx("p", { style: styles.hint, children: t("noAccounts") }),
            ],
          }),
          accounts.some((a) => Array.isArray(a.quota) && a.quota.length > 0)
            ? jsx("p", { style: styles.hint, children: t("sessionsHint") })
            : null,
          jsx(Feedback, { kind: feedback, children: t("saved") }),
          feedback === "error" && errorMessage
            ? jsx("p", { role: "alert", style: styles.error, children: errorMessage })
            : null,
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Command Code card (accounts + plan filter)
     * ------------------------------------------------------------------ */
    function CommandCodeCard({ t, enabled, onToggleEnabled }) {
      const [open, setOpen] = react.useState(false);
      const [auth, setAuth] = react.useState({ status: "loading" });
      const [accounts, setAccounts] = react.useState([]);
      const [planTiers, setPlanTiers] = react.useState([]);
      const [busy, setBusy] = react.useState(false);
      const [feedback, setFeedback] = react.useState("idle");
      const [errorMessage, setErrorMessage] = react.useState("");

      const refreshAuth = react.useCallback(async () => {
        try {
          const [status, acc, plans] = await Promise.all([
            jsonRequest(PATHS.commandcode.status),
            jsonRequest(PATHS.commandcode.accounts),
            jsonRequest(PATHS.commandcode.plans),
          ]);
          setAuth(status);
          setAccounts(Array.isArray(acc?.accounts) ? acc.accounts : []);
          setPlanTiers(Array.isArray(plans?.tiers) ? plans.tiers : []);
        } catch {
          setAuth({ status: "error" });
        }
      }, []);

      react.useEffect(() => { refreshAuth(); }, [refreshAuth]);
      usePolling(refreshAuth, auth.pending === true);

      const authorize = async () => {
        setBusy(true);
        setFeedback("idle");
        setErrorMessage("");
        try {
          const result = await jsonRequest(PATHS.commandcode.login, "POST");
          if (typeof result?.url === "string") window.open(result.url, "_blank", "noopener");
          await refreshAuth();
        } catch (error) {
          setFeedback("error");
          setErrorMessage(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      };

      const togglePlan = async (tier) => {
        const current = new Set(planTiers.filter((entry) => entry.enabled).map((entry) => entry.tier));
        if (current.has(tier)) current.delete(tier);
        else current.add(tier);
        const next = [...current];
        setBusy(true);
        setFeedback("idle");
        setErrorMessage("");
        try {
          const result = await jsonRequest(PATHS.commandcode.plans, "PUT", { tiers: next });
          setPlanTiers(Array.isArray(result?.tiers) ? result.tiers : []);
          setFeedback("saved");
        } catch (error) {
          setFeedback("error");
          setErrorMessage(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      };

      const removeAccount = async (index) => {
        setBusy(true);
        setFeedback("idle");
        setErrorMessage("");
        try {
          await jsonRequest(PATHS.commandcode.accounts, "DELETE", { index });
          await refreshAuth();
        } catch (error) {
          setFeedback("error");
          setErrorMessage(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      };

      const waiting = auth.pending === true;
      const signedIn = auth.signedIn === true;
      const pill = {
        tone: statusTone(auth.status, signedIn),
        label: statusCopy(auth.status, signedIn, t),
      };

      return jsx(CardShell, {
        open,
        onToggle: () => setOpen(!open),
        logo: LOGOS.commandcode,
        logoBg: "#ffffff",
        title: t("title"),
        intro: t("intro"),
        pill,
        switchProps: { checked: enabled === true, onChange: onToggleEnabled },
        children: [
          jsxs("div", {
            style: styles.block,
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
                children: [
                  jsx("span", { style: styles.blockLabel, children: t("accounts") }),
                  jsx("button", { type: "button", style: styles.buttonPrimary, disabled: busy || waiting, onClick: authorize, children: t("addAccount") }),
                ],
              }),
              waiting
                ? jsx("p", { role: "status", style: styles.statusText, children: t("waiting") })
                : signedIn
                  ? jsx("p", { style: styles.hint, children: auth.email || auth.userName || t("signedIn") })
                  : jsx("p", { style: styles.hint, children: t("signedOutHelp") }),
            ],
          }),
          accounts.length > 0
            ? jsx("div", {
                style: { display: "flex", flexDirection: "column", gap: 6 },
                children: accounts.map((account) =>
                  jsxs("div", {
                    key: account.index,
                    style: styles.accountRow,
                    children: [
                      jsxs("div", {
                        style: styles.accountMain,
                        children: [
                          jsxs("div", {
                            style: styles.accountName,
                            children: [
                              jsx("span", { style: styles.accountText, children: account.email || account.userName || account.keyName }),
                              account.keyName ? jsx("span", { style: styles.planBadge, children: account.keyName }) : null,
                            ],
                          }),
                        ],
                      }),
                      jsx("button", { type: "button", style: { ...styles.button, alignSelf: "center" }, disabled: busy, onClick: () => removeAccount(account.index), children: t("remove") }),
                    ],
                  }),
                ),
              })
            : null,
          jsx("div", {
            style: styles.block,
            children: [
              jsx("span", { style: styles.blockLabel, children: t("showPlans") }),
              jsx("div", {
                style: { display: "flex", flexWrap: "wrap", gap: 8 },
                children: planTiers.map((entry) => {
                  const enabled = entry.enabled === true;
                  return jsxs("button", {
                    key: entry.tier,
                    type: "button",
                    role: "checkbox",
                    "aria-checked": enabled,
                    style: enabled ? styles.planChipOn : styles.planChip,
                    disabled: busy,
                    onClick: () => togglePlan(entry.tier),
                    children: [
                      enabled ? jsx("span", { style: styles.checkMark, children: "✓" }) : null,
                      jsx("span", { children: entry.label }),
                    ],
                  });
                }),
              }),
            ],
          }),
          jsx(Feedback, { kind: feedback, children: t("saved") }),
          feedback === "error" && errorMessage
            ? jsx("p", { role: "alert", style: styles.error, children: errorMessage })
            : null,
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * ZED card (accounts + plan badge)
     * ------------------------------------------------------------------ */
    function ZedCard({ t, enabled, onToggleEnabled }) {
      const [open, setOpen] = react.useState(false);
      const [auth, setAuth] = react.useState({ status: "loading" });
      const [accounts, setAccounts] = react.useState([]);
      const [busy, setBusy] = react.useState(false);
      const [feedback, setFeedback] = react.useState("idle");
      const [errorMessage, setErrorMessage] = react.useState("");

      const refreshAuth = react.useCallback(async () => {
        try {
          const [status, acc] = await Promise.all([jsonRequest(PATHS.zed.status), jsonRequest(PATHS.zed.accounts)]);
          setAuth(status);
          setAccounts(Array.isArray(acc?.accounts) ? acc.accounts : []);
        } catch {
          setAuth({ status: "error" });
        }
      }, []);

      react.useEffect(() => { refreshAuth(); }, [refreshAuth]);
      usePolling(refreshAuth, auth.pending === true);

      const addAccount = async () => {
        setBusy(true);
        setFeedback("idle");
        setErrorMessage("");
        try {
          const result = await jsonRequest(PATHS.zed.login, "POST");
          if (typeof result?.url === "string") window.open(result.url, "_blank", "noopener");
          await refreshAuth();
        } catch (error) {
          setFeedback("error");
          setErrorMessage(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      };

      const removeAccount = async (index) => {
        setBusy(true);
        setFeedback("idle");
        setErrorMessage("");
        try {
          await jsonRequest(PATHS.zed.accounts, "DELETE", { index });
          await refreshAuth();
        } catch (error) {
          setFeedback("error");
          setErrorMessage(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      };

      const waiting = auth.pending === true;
      const signedIn = auth.signedIn === true;
      const freeOnly = accounts.length > 0 && accounts.every((account) => !account.plan || account.plan === "zed_free");
      const pill = {
        tone: statusTone(auth.status, signedIn),
        label: statusCopy(auth.status, signedIn, t),
      };

      return jsx(CardShell, {
        open,
        onToggle: () => setOpen(!open),
        logo: LOGOS.zed,
        logoBg: "#1c1f24",
        title: t("title"),
        intro: t("intro"),
        pill,
        switchProps: { checked: enabled === true, onChange: onToggleEnabled },
        children: [
          jsxs("div", {
            style: styles.block,
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
                children: [
                  jsx("span", { style: styles.blockLabel, children: t("accounts") }),
                  jsx("button", { type: "button", style: styles.buttonPrimary, disabled: busy || waiting, onClick: addAccount, children: t("addAccount") }),
                ],
              }),
              waiting
                ? jsx("p", { role: "status", style: styles.statusText, children: t("waiting") })
                : accounts.length > 0
                  ? jsx("div", {
                      style: { display: "flex", flexDirection: "column", gap: 6 },
                      children: accounts.map((account) =>
                        jsxs("div", {
                          key: account.index,
                          style: styles.accountRow,
                          children: [
                            jsxs("div", {
                              style: styles.accountMain,
                              children: [
                                jsxs("div", {
                                  style: styles.accountName,
                                  children: [
                                    jsx("span", { style: styles.accountText, children: account.login }),
                                    account.plan
                                      ? jsx("span", { style: styles.planBadge, children: planLabel(account.plan) })
                                      : null,
                                  ],
                                }),
                                jsx("span", { style: styles.accountSub, children: "user_id " + account.userId }),
                              ],
                            }),
                            jsx("button", { type: "button", style: { ...styles.button, alignSelf: "center" }, disabled: busy, onClick: () => removeAccount(account.index), children: t("remove") }),
                          ],
                        }),
                      ),
                    })
                  : jsx("p", { style: styles.hint, children: t("noAccounts") }),
            ],
          }),
          freeOnly
            ? jsx("p", { style: styles.warn, children: t("freeWarning") })
            : null,
          jsx(Feedback, { kind: feedback, children: t("saved") }),
          feedback === "error" && errorMessage
            ? jsx("p", { role: "alert", style: styles.error, children: errorMessage })
            : null,
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Codex card (ChatGPT OAuth sign in / cancel / sign out + usage)
     * ------------------------------------------------------------------ */
    function formatWindow(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return "";
      const days = seconds / 86400;
      if (days >= 1) return `${Math.round(days)}d`;
      const hours = seconds / 3600;
      if (hours >= 1) return `${Math.round(hours)}h`;
      return `${Math.round(seconds / 60)}m`;
    }

    function CodexCard({ t, enabled, onToggleEnabled }) {
      const [open, setOpen] = react.useState(false);
      const [auth, setAuth] = react.useState({ status: "signed-out", signedIn: false, pending: false });
      const [accounts, setAccounts] = react.useState([]);
      const [usage, setUsage] = react.useState(undefined);
      const [busy, setBusy] = react.useState(false);
      const [feedback, setFeedback] = react.useState("idle");
      const [errorMessage, setErrorMessage] = react.useState("");

      const refresh = react.useCallback(async () => {
        try {
          const [status, acc] = await Promise.all([
            jsonRequest(PATHS.codex.status),
            jsonRequest(PATHS.codex.accounts),
          ]);
          setAuth(status && typeof status === "object" ? status : { status: "signed-out", signedIn: false, pending: false });
          setAccounts(Array.isArray(acc?.accounts) ? acc.accounts : []);
          if (typeof status?.error === "string") setErrorMessage(status.error);
        } catch (error) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }, []);

      const refreshUsage = react.useCallback(async () => {
        try {
          const result = await jsonRequest(PATHS.codex.usage);
          setUsage(result?.usage);
        } catch {
          // usage is best-effort; keep the last value
        }
      }, []);

      react.useEffect(() => { refresh(); }, [refresh]);
      usePolling(refresh, auth.pending === true);
      react.useEffect(() => {
        if (auth.signedIn !== true) return undefined;
        refreshUsage();
        const interval = window.setInterval(refreshUsage, 60000);
        return () => window.clearInterval(interval);
      }, [auth.signedIn, refreshUsage]);

      const run = async (action, onSaved) => {
        setBusy(true);
        setErrorMessage("");
        setFeedback("idle");
        try {
          const result = await action();
          if (typeof result?.url === "string") window.open(result.url, "_blank", "noopener");
          await refresh();
          if (onSaved) setFeedback("saved");
        } catch (error) {
          setFeedback("error");
          setErrorMessage(error instanceof Error ? error.message : String(error));
          await refresh();
        } finally {
          setBusy(false);
        }
      };

      const addAccount = () => run(() => jsonRequest(PATHS.codex.login, "POST"));
      const cancel = () => run(() => jsonRequest(PATHS.codex.cancel, "POST"));
      const signOut = () => run(() => jsonRequest(PATHS.codex.logout, "POST"), true);
      const removeAccount = (index) => run(() => jsonRequest(PATHS.codex.accounts, "DELETE", { index }), true);
      const waiting = auth.pending === true;
      const signedIn = auth.signedIn === true;

      const pill = {
        tone: statusTone(auth.status, signedIn),
        label: statusCopy(auth.status, signedIn, t),
      };

      const primaryLimit = usage?.rateLimits?.find((limit) => limit.id === "codex");
      const primaryWindow = primaryLimit?.windows?.[0];
      const remaining = primaryWindow?.remainingPercent;

      return jsx(CardShell, {
        open,
        onToggle: () => setOpen(!open),
        logo: LOGOS.codex,
        logoBg: "#ffffff",
        title: t("title"),
        intro: t("intro"),
        pill,
        switchProps: { checked: enabled === true, onChange: onToggleEnabled },
        children: [
          jsxs("div", {
            style: styles.block,
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
                children: [
                  jsx("span", { style: styles.blockLabel, children: t("accounts") }),
                  waiting
                    ? jsx("button", { type: "button", style: styles.button, disabled: busy, onClick: cancel, children: busy ? t("working") : t("cancel") })
                    : jsx("button", { type: "button", style: styles.buttonPrimary, disabled: busy, onClick: addAccount, children: t("addAccount") }),
                ],
              }),
              waiting
                ? jsx("p", { role: "status", style: styles.statusText, children: t("waiting") })
                : accounts.length > 0
                  ? jsx("div", {
                      style: { display: "flex", flexDirection: "column", gap: 6 },
                      children: accounts.map((account) =>
                        jsxs("div", {
                          key: account.index,
                          style: styles.accountRow,
                          children: [
                            jsxs("div", {
                              style: styles.accountMain,
                              children: [
                                jsxs("div", {
                                  style: styles.accountName,
                                  children: [
                                    jsx("span", { style: styles.accountText, children: account.email || `account-${account.index + 1}` }),
                                    account.plan
                                      ? jsx("span", { style: styles.planBadge, children: planLabel(account.plan) })
                                      : null,
                                  ],
                                }),
                                jsx("span", { style: styles.accountSub, children: t("tokenExpiry") + ": " + formatExpiry(account.expiresAt) }),
                              ],
                            }),
                            jsx("button", { type: "button", style: { ...styles.button, alignSelf: "center" }, disabled: busy, onClick: () => removeAccount(account.index), children: t("remove") }),
                          ],
                        }),
                      ),
                    })
                  : jsx("p", { style: styles.hint, children: t("noAccounts") }),
            ],
          }),
          signedIn && typeof remaining === "number"
            ? jsx("div", {
                style: styles.block,
                children: [
                  jsx("span", { style: styles.blockLabel, children: t("weeklyQuota") }),
                  jsx("div", {
                    style: styles.quotaLine,
                    children: [
                      jsx("span", {
                        style: styles.quotaTrack,
                        children: jsx("span", {
                          style: {
                            ...styles.quotaFill,
                            width: `${Math.max(0, Math.min(100, remaining))}%`,
                            background: remaining > 30 ? "var(--dsw-alias-state-success-primary)" : remaining > 10 ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-state-error-primary)",
                          },
                        }),
                      }),
                      jsx("span", { style: styles.accountSub, children: `${Math.round(remaining)}% ${t("remaining")} · ${formatWindow(primaryWindow?.windowSeconds)} ${t("window")}` }),
                    ],
                  }),
                  usage?.credits
                    ? jsx("p", { style: styles.hint, children: `${t("credits")}: ${usage.credits.unlimited ? "∞" : (usage.credits.balance ?? "0")}` })
                    : null,
                ],
              })
            : null,
          jsx(Feedback, { kind: feedback, children: t("saved") }),
          feedback === "error" && errorMessage
            ? jsx("p", { role: "alert", style: styles.error, children: errorMessage })
            : null,
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Seraphim settings section: hero + the five cards.
     * ------------------------------------------------------------------ */
    const CARDS = [
      { id: "claude-code", Component: ClaudeCodeCard },
      { id: "freebuff", Component: FreeBuffCard },
      { id: "commandcode", Component: CommandCodeCard },
      { id: "zed", Component: ZedCard },
      { id: "codex", Component: CodexCard },
    ];

    function SeraphimSection({ t, tClaudeCode, tFreebuff, tCommandcode, tZed, tCodex, settings }) {
      const [cards, setCards] = react.useState({});
      const [flags, setFlags] = react.useState({});
      const [flagsBusy, setFlagsBusy] = react.useState({});
      const [flagsError, setFlagsError] = react.useState("");
      react.useEffect(() => {
        let mounted = true;
        (async () => {
          const results = await Promise.allSettled(
            Object.entries(PATHS).map(async ([key, paths]) => {
              const value = await jsonRequest(paths.status);
              return [key, value];
            }),
          );
          if (!mounted) return;
          const next = {};
          for (const result of results) {
            if (result.status === "fulfilled") {
              const [key, value] = result.value;
              next[key] = value;
            }
          }
          setCards(next);
        })();
        return () => { mounted = false; };
      }, []);

      // Provider on/off flags: defaults to all-on until the host route answers.
      const refreshFlags = react.useCallback(async () => {
        try {
          const value = await jsonRequest(PROVIDER_FLAGS_PATH);
          const next = {};
          for (const item of Array.isArray(value?.providers) ? value.providers : []) next[item.key] = item.enabled === true;
          setFlags(next);
        } catch {
          /* switches stay in their default on state until the route answers */
        }
      }, []);

      react.useEffect(() => {
        refreshFlags();
      }, [refreshFlags]);

      async function toggleProvider(key, next) {
        if (flagsBusy[key]) return;
        setFlags((prev) => ({ ...prev, [key]: next }));
        setFlagsBusy((prev) => ({ ...prev, [key]: true }));
        setFlagsError("");
        try {
          const value = await jsonRequest(PROVIDER_FLAGS_PATH, "PUT", { enabled: { [key]: next } });
          const applied = {};
          for (const item of Array.isArray(value?.providers) ? value.providers : []) applied[item.key] = item.enabled === true;
          setFlags(applied);
        } catch (error) {
          setFlags((prev) => ({ ...prev, [key]: !next }));
          setFlagsError(error instanceof Error ? error.message : String(error));
        } finally {
          setFlagsBusy((prev) => ({ ...prev, [key]: false }));
        }
      }

      const chips = [
        { id: "claude-code", label: t("claudeChip"), tone: cards["claude-code"]?.signedIn ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-tertiary)" },
        { id: "freebuff", label: t("freebuffChip"), tone: cards.freebuff?.signedIn ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-tertiary)" },
        { id: "commandcode", label: t("commandcodeChip"), tone: cards.commandcode?.signedIn ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-tertiary)" },
        { id: "zed", label: t("zedChip"), tone: cards.zed?.signedIn ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-tertiary)" },
        { id: "codex", label: t("codexChip"), tone: cards.codex?.signedIn ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-tertiary)" },
      ];

      const sectionRef = react.useRef(null);
      // Pin the real scroll container before paint to prevent classic-scrollbar layout shift.
      react.useLayoutEffect(() => {
        const el = sectionRef.current;
        if (!el || typeof getComputedStyle === "undefined") return undefined;
        let node = el.parentElement;
        while (node && node !== document.body) {
          const cs = getComputedStyle(node);
          const overY = cs.overflowY;
          if (overY === "auto" || overY === "scroll") {
            const prev = node.style.overflowY;
            node.style.overflowY = "scroll";
            return () => {
              node.style.overflowY = prev;
            };
          }
          node = node.parentElement;
        }
        return undefined;
      }, []);

      return jsx("div", {
        ref: sectionRef,
        className: "dsh-seraphim-section",
        style: styles.section,
        children: [
          jsx("header", {
            style: styles.hero,
            children: [
              jsx("h1", { style: styles.heroTitle, children: t("heroTitle") }),
              jsx("p", { style: styles.heroSub, children: t("heroSub") }),
              jsx("div", {
                style: styles.heroMeta,
                children: chips.map((chip) =>
                  jsxs("span", {
                    key: chip.id,
                    style: { ...styles.metaChip, ...(flags[chip.id] === false ? { opacity: 0.45 } : {}) },
                    children: [
                      jsx("span", { "aria-hidden": "true", style: { ...styles.metaChipDot, background: chip.tone } }),
                      jsx("span", { children: chip.label }),
                    ],
                  }),
                ),
              }),
            ],
          }),
          jsx(BetterModelSelectionRow, { t, settings }),
          flagsError
            ? jsx("p", { role: "alert", style: styles.error, children: flagsError })
            : null,
          jsx(ClaudeCodeCard, { t: tClaudeCode, enabled: flags["claude-code"] !== false, onToggleEnabled: (next) => toggleProvider("claude-code", next) }, "claude-code"),
          jsx(FreeBuffCard, { t: tFreebuff, enabled: flags.freebuff !== false, onToggleEnabled: (next) => toggleProvider("freebuff", next) }, "freebuff"),
          jsx(CommandCodeCard, { t: tCommandcode, enabled: flags.commandcode !== false, onToggleEnabled: (next) => toggleProvider("commandcode", next) }, "commandcode"),
          jsx(ZedCard, { t: tZed, enabled: flags.zed !== false, onToggleEnabled: (next) => toggleProvider("zed", next) }, "zed"),
          jsx(CodexCard, { t: tCodex, enabled: flags.codex !== false, onToggleEnabled: (next) => toggleProvider("codex", next) }, "codex"),
        ],
      });
    }

    function apply(ctx) {
      const namespace = "settings.seraphim";
      const settingsScope = ctx.get?.("settingsScope");
      const settings = settingsScope?.bind({ namespace: SERAPHIM_SETTINGS_NS, decode: (value) => typeof value === "object" && value !== null ? value : { betterModelSelection: false } });
      const nsClaudeCode = "settings.seraphim.claude-code";
      const nsFreebuff = "settings.seraphim.freebuff";
      const nsCommandcode = "settings.seraphim.commandcode";
      const nsZed = "settings.seraphim.zed";
      const nsCodex = "settings.seraphim.codex";
      ctx.effect(() => ctx.locale.register(namespace, { en: enSeraphim }), "dsh-seraphim: section copy");
      ctx.effect(() => ctx.locale.register(nsClaudeCode, { en: enClaudeCode }), "dsh-seraphim: claude-code copy");
      ctx.effect(() => ctx.locale.register(nsFreebuff, { en: enFreebuff }), "dsh-seraphim: freebuff copy");
      ctx.effect(() => ctx.locale.register(nsCommandcode, { en: enCommandcode }), "dsh-seraphim: commandcode copy");
      ctx.effect(() => ctx.locale.register(nsZed, { en: enZed }), "dsh-seraphim: zed copy");
      ctx.effect(() => ctx.locale.register(nsCodex, { en: enCodex }), "dsh-seraphim: codex copy");
      const t = ctx.locale.bind(namespace);
      const tClaudeCode = ctx.locale.bind(nsClaudeCode);
      const tFreebuff = ctx.locale.bind(nsFreebuff);
      const tCommandcode = ctx.locale.bind(nsCommandcode);
      const tZed = ctx.locale.bind(nsZed);
      const tCodex = ctx.locale.bind(nsCodex);
      ctx.effect(() => injectStyles(), "dsh-seraphim: styles");
      const registerBetterModelSlot = () => ctx.slots.register({
        name: MODEL_SLOT,
        priority: MODEL_SLOT_PRIORITY,
        locale: namespace,
        inject: (sessionId) => {
          const directory = ctx.modelDirectories.directoryFor(sessionId);
          const available = ctx.sessions.subagentAddress(sessionId) === undefined;
          return {
            available,
            directory: directory.store,
            load: () => {
              if (available) directory.load().catch(() => {});
            },
            select: (selection) => available ? directory.select(selection).then(() => true, () => false) : Promise.resolve(false),
            copy: (key) => t(`betterModelSelection.${key}`),
          };
        },
      }, BetterModelSelect);
      ctx.slots.inject(MODEL_SLOT, () => {
        let dispose;
        const sync = () => {
          const snapshot = settings?.getSnapshot?.();
          const enabled = snapshot?.status === "ready" && snapshot.value?.betterModelSelection === true;
          if (enabled && dispose === undefined) dispose = registerBetterModelSlot();
          if (!enabled && dispose !== undefined) {
            dispose();
            dispose = undefined;
          }
        };
        sync();
        const unsubscribe = settings?.subscribe?.(sync) ?? (() => {});
        return () => {
          unsubscribe();
          dispose?.();
          dispose = undefined;
        };
      });
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "seraphim",
        order: 20,
        label: () => t("tab.label"),
        locale: namespace,
        inject: () => ({ t, tClaudeCode, tFreebuff, tCommandcode, tZed, tCodex, settings }),
      }, SeraphimSection));
    }

    /* ------------------------------------------------------------------ *
     * CSS - hover/focus affordances on top of the inline tokens.
     * ------------------------------------------------------------------ */
    const CSS_ID = "dsh-seraphim/src/client/SeraphimSection.css";
    function injectStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-seraphim";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = [
        ".dsh-seraphim-card-header:hover { background: var(--dsw-alias-interactive-bg-hover); }",
        ".dsh-seraphim-card-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }",
        ".dsh-seraphim-section button:disabled { opacity: .55; cursor: default; }",
        ".dsh-seraphim-card-switch:hover { color: var(--dsw-alias-label-primary); }",
        ".dsh-seraphim-card-switch:hover .dsh-seraphim-card-switch-track { border-color: var(--dsw-alias-brand-primary); }",
        ".dsh-seraphim-card-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 6px; }",
        ".dsh-seraphim-model-trigger:hover:not(:disabled), .dsh-seraphim-model-trigger:focus-visible { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }",
        ".dsh-seraphim-model-trigger:focus-visible, .dsh-seraphim-model-menu-root button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; box-shadow: none; }",
        ".dsh-seraphim-model-menu-root button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }",
        "@media (max-width: 560px) { .dsh-seraphim-model-menu-root { position: static; } .dsh-seraphim-model-menu-root .dsh-seraphim-model-menu { position: fixed; left: 12px; right: 12px; bottom: 12px; width: auto; max-height: calc(100vh - 24px); grid-template-columns: 1fr; } .dsh-seraphim-model-menu-root .dsh-seraphim-model-menu > div + div { border-left: 0 !important; border-top: 1px solid var(--dsw-alias-border-l1); } }",
      ].join("\n");
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------------ *
     * Copy
     * ------------------------------------------------------------------ */
    const enSeraphim = {
      "tab.label": "Seraphim",
      heroTitle: "Seraphim",
      heroSub: "Claude Code, FreeBuff, Command Code, ZED and Codex as native dsh providers. Sign in per provider; each keeps its own credentials and model list.",
      claudeChip: "Claude Code",
      freebuffChip: "FreeBuff",
      commandcodeChip: "Command Code",
      zedChip: "ZED",
      codexChip: "Codex",
      "betterModelSelection.title": "Better Model Selection",
      "betterModelSelection.description": "Use provider-first navigation in the composer model control.",
      "betterModelSelection.aria": "Better Model Selection",
      "betterModelSelection.on": "On",
      "betterModelSelection.off": "Off",
      "betterModelSelection.loading": "Loading…",
      "betterModelSelection.saveFailed": "Could not save this setting.",
      "betterModelSelection.providers": "Providers",
      "betterModelSelection.dshProviders": "DSH Provider",
      "betterModelSelection.seraphimProviders": "Seraphim AIO",
      "betterModelSelection.models": "models",
      "betterModelSelection.chooseModel": "Choose a model",
      "betterModelSelection.chooseProvider": "Choose a provider",
      "betterModelSelection.noProviders": "No providers available.",
      "betterModelSelection.noModels": "No models available for this provider.",
      "betterModelSelection.selectModel": "Select model",
      "betterModelSelection.menuAria": "Providers and models",
      "betterModelSelection.selectionFailed": "Model selection failed.",
      "betterModelSelection.retry": "Retry",
      "betterModelSelection.effort": "Reasoning effort",
      "betterModelSelection.defaultEffort": "Default",
    };

    const enClaudeCode = {
      title: "Claude Code",
      intro: "Claude Code subscription models",
      signedOut: "Not connected",
      signedOutHelp: "Add a Claude Code account to start. Sign in with OAuth, or import an existing Claude Code login.",
      waiting: "Waiting for authorization...",
      signedIn: "Connected",
      expired: "Expired",
      errorStatus: "Needs attention",
      importLogin: "Import existing login",
      cancel: "Cancel",
      signOut: "Sign out",
      working: "Working...",
      accounts: "Accounts",
      addAccount: "Add account",
      importedAccount: "Imported account",
      oauthAccount: "Claude Code account",
      window5h: "5h",
      windowWeekly: "Weekly",
      saved: "Saved",
      remove: "Remove",
    };

    const enFreebuff = {
      title: "FreeBuff",
      intro: "Free Codebuff models",
      signedOut: "Not connected",
      signedIn: "Connected",
      waiting: "Waiting for authorization...",
      errorStatus: "Needs attention",
      expired: "Expired",
      accounts: "Accounts",
      noAccounts: "No accounts yet. Add one to start.",
      addAccount: "Add account",
      saved: "Saved",
      remove: "Remove",
      remaining: "remaining",
      sessionsHint: "Session quota (used/limit) - resets daily ~07:00 UTC (Pacific midnight).",
    };

    const enCommandcode = {
      title: "Command Code",
      intro: "Command Code AI models",
      signedOut: "Not connected",
      signedIn: "Signed in",
      waiting: "Waiting for authorization...",
      errorStatus: "Needs attention",
      expired: "Expired",
      accounts: "Accounts",
      addAccount: "Add account",
      signedOutHelp: "Add a Command Code account to start.",
      showPlans: "Show models from these plans",
      saved: "Saved",
      remove: "Remove",
    };

    const enZed = {
      title: "ZED",
      intro: "Zed.dev cloud LLM (Anthropic / OpenAI / Google / xAI)",
      signedOut: "Not connected",
      signedIn: "Signed in",
      waiting: "Waiting for GitHub authorization...",
      errorStatus: "Needs attention",
      expired: "Expired",
      accounts: "Accounts",
      noAccounts: "No accounts yet. Add one to start.",
      addAccount: "Add account",
      saved: "Saved",
      remove: "Remove",
      freeWarning: "All accounts are on the Free plan, which has no hosted LLM access (edit predictions only). Start a 14-day Pro trial at zed.dev/account/start-trial - GitHub accounts must be older than 30 days.",
    };

    const enCodex = {
      title: "Codex",
      intro: "OpenAI Codex models via ChatGPT (Plus/Pro)",
      signedOut: "Not connected",
      signedIn: "Signed in",
      waiting: "Waiting for ChatGPT authorization...",
      errorStatus: "Needs attention",
      expired: "Expired",
      accounts: "Accounts",
      noAccounts: "No accounts yet. Add one to start.",
      addAccount: "Add account",
      cancel: "Cancel",
      saved: "Saved",
      remove: "Remove",
      tokenExpiry: "Access token expires",
      weeklyQuota: "Weekly Codex quota",
      remaining: "remaining",
      window: "window",
      credits: "Credits",
    };

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
