const {
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
} = require("obsidian");

const PLUGIN_ID = "copilot-chat-marker";
const COPILOT_ID = "copilot";
const AGENT_VIEW_TYPE = "copilot-agent-chat-view";
const PATCH_PROPERTY = "__copilotChatMarkerOriginalRunTurn";

const DEFAULT_MARKERS = [
  {
    id: "progress",
    icon: "👍",
    title: "Progress",
    instruction:
      "This chat is making useful progress. Continue in the current direction unless the user changes it.",
  },
  {
    id: "idea",
    icon: "💡",
    title: "Worth revisiting",
    instruction:
      "Treat this as an idea worth revisiting, not as a settled decision or commitment.",
  },
  {
    id: "question",
    icon: "❓",
    title: "Question",
    instruction:
      "An important question remains unresolved. Keep the uncertainty visible and help resolve it.",
  },
  {
    id: "radar",
    icon: "👁️",
    title: "On my radar",
    instruction:
      "Keep this on the user's radar without treating it as urgent or decided.",
  },
  {
    id: "explain",
    icon: "🧠",
    title: "Above my understanding",
    instruction:
      "The current material is above the user's understanding. Use plainer language, smaller steps, and define necessary terms.",
  },
  {
    id: "idle",
    icon: "💤",
    title: "Idle",
    instruction:
      "This chat was intentionally parked for a later return. Re-establish the immediate context before advancing it.",
  },
  {
    id: "done",
    icon: "✅",
    title: "Finished",
    instruction:
      "The chat's intended outcome is complete. Do not invent additional work unless the user reopens the direction.",
  },
];

const DEFAULT_SETTINGS = {
  markers: DEFAULT_MARKERS,
  sessionMarkers: {},
};

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function normalizeMarker(raw, index) {
  const id =
    typeof raw?.id === "string" && raw.id.trim()
      ? raw.id.trim()
      : `marker-${Date.now().toString(36)}-${index}`;

  return {
    id,
    icon: typeof raw?.icon === "string" ? raw.icon.trim() : "✨",
    title:
      typeof raw?.title === "string" && raw.title.trim()
        ? raw.title.trim()
        : "Marker",
    instruction:
      typeof raw?.instruction === "string" ? raw.instruction.trim() : "",
  };
}

class CopilotChatMarkerPlugin extends Plugin {
  async onload() {
    this.unloaded = false;
    const stored = (await this.loadData()) || {};
    this.settings = {
      ...cloneDefaults(),
      ...stored,
      markers: Array.isArray(stored.markers)
        ? stored.markers.map(normalizeMarker)
        : cloneDefaults().markers,
      sessionMarkers:
        stored.sessionMarkers && typeof stored.sessionMarkers === "object"
          ? stored.sessionMarkers
          : {},
    };

    this.manager = null;
    this.managerUnsubscribe = null;
    this.lastActiveSessionKey = null;
    this.compatibilityMessage = "Waiting for Copilot Agent.";
    this.compatible = false;
    this.saveTimer = null;
    this.refreshFrame = null;

    this.addSettingTab(new CopilotChatMarkerSettingTab(this.app, this));

    this.addCommand({
      id: "choose-marker",
      name: "Choose marker for active Copilot chat",
      callback: () => this.openMarkerMenu(),
    });

    this.addCommand({
      id: "clear-marker",
      name: "Clear marker from active Copilot chat",
      callback: () => void this.clearActiveMarker(),
    });

    this.addRibbonIcon("tags", "Mark active Copilot chat", (event) => {
      this.openMarkerMenu(event);
    });

    this.observer = new MutationObserver(() => this.scheduleRefresh());
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.register(() => this.observer.disconnect());

    this.registerInterval(
      window.setInterval(() => this.refreshIntegration(), 1500)
    );

    this.refreshIntegration();
  }

  onunload() {
    this.unloaded = true;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    if (this.refreshFrame) window.cancelAnimationFrame(this.refreshFrame);
    this.refreshScheduled = false;
    if (this.managerUnsubscribe) this.managerUnsubscribe();
    this.managerUnsubscribe = null;
    this.restorePatchedSessions();
    this.manager = null;
    document
      .querySelectorAll(".copilot-chat-marker-button")
      .forEach((button) => button.remove());
  }

  scheduleRefresh() {
    if (this.unloaded || this.refreshScheduled) return;
    this.refreshScheduled = true;
    this.refreshFrame = window.requestAnimationFrame(() => {
      this.refreshFrame = null;
      this.refreshScheduled = false;
      if (this.unloaded) return;
      this.refreshIntegration();
    });
  }

  getCopilotPlugin() {
    return this.app.plugins?.getPlugin?.(COPILOT_ID) || null;
  }

  getManager() {
    return this.getCopilotPlugin()?.agentSessionManager || null;
  }

  validateManager(manager) {
    const required = [
      "getActiveSession",
      "getSessions",
      "renameSession",
      "saveActiveSession",
      "subscribe",
      "updateChatTitle",
    ];

    const missing = required.filter(
      (method) => typeof manager?.[method] !== "function"
    );

    if (missing.length) {
      return {
        ok: false,
        message: `Copilot compatibility unavailable: missing ${missing.join(", ")}.`,
      };
    }

    return { ok: true, message: "Compatible with the active Copilot Agent." };
  }

  refreshIntegration() {
    if (this.unloaded) return;
    const manager = this.getManager();
    const validation = this.validateManager(manager);
    this.compatible = validation.ok;
    this.compatibilityMessage = validation.message;

    if (manager !== this.manager) {
      if (this.managerUnsubscribe) this.managerUnsubscribe();
      this.restorePatchedSessions();
      this.manager = validation.ok ? manager : null;
      this.managerUnsubscribe = this.manager
        ? this.manager.subscribe(() => this.scheduleRefresh())
        : null;
    }

    if (this.manager) {
      this.patchSessions();
      this.rearmMarkerWhenSessionChanges();
      this.syncActiveStateFromTitle();
    }

    this.injectToolbarButtons();
    this.updateToolbarButtons();
  }

  getSessionKey(session) {
    if (!session) return null;
    const backendSessionId =
      session.getBackendSessionId?.() || session.backendSessionId || null;
    const id = backendSessionId || session.internalId;
    if (!id) return null;
    return `${session.backendId || "unknown"}:${id}`;
  }

  getMarker(markerId) {
    return this.settings.markers.find((marker) => marker.id === markerId) || null;
  }

  getMarkerFromLabel(label) {
    const value = typeof label === "string" ? label : "";
    return (
      [...this.settings.markers]
        .sort((a, b) => b.icon.length - a.icon.length)
        .find((marker) => marker.icon && value.startsWith(marker.icon)) || null
    );
  }

  getActiveSession() {
    return this.manager?.getActiveSession?.() || null;
  }

  getActiveState() {
    const session = this.getActiveSession();
    const key = this.getSessionKey(session);
    return key ? this.settings.sessionMarkers[key] || null : null;
  }

  patchSessions() {
    for (const session of this.manager.getSessions()) {
      if (
        !session ||
        typeof session.runTurn !== "function" ||
        session[PATCH_PROPERTY]
      ) {
        continue;
      }

      const originalRunTurn = session.runTurn;
      const plugin = this;

      session[PATCH_PROPERTY] = originalRunTurn;
      session.runTurn = async function (message, ...args) {
        return plugin.runTurnWithMarker(this, originalRunTurn, message, args);
      };
    }
  }

  restorePatchedSessions() {
    const manager = this.manager || this.getManager();
    if (!manager || typeof manager.getSessions !== "function") return;

    for (const session of manager.getSessions()) {
      if (!session?.[PATCH_PROPERTY]) continue;
      session.runTurn = session[PATCH_PROPERTY];
      delete session[PATCH_PROPERTY];
    }
  }

  async runTurnWithMarker(session, originalRunTurn, message, args) {
    const key = this.getSessionKey(session);
    let state = key ? this.settings.sessionMarkers[key] : null;
    const titleMarker = this.getMarkerFromLabel(session?.getLabel?.() || "");

    if (key && titleMarker && state?.markerId !== titleMarker.id) {
      state = {
        markerId: titleMarker.id,
        baseLabel: this.stripKnownPrefix(session.getLabel?.() || ""),
        pending: true,
        updatedAt: Date.now(),
      };
      this.settings.sessionMarkers[key] = state;
      this.queueSave();
    }

    const marker = titleMarker || (state ? this.getMarker(state.markerId) : null);

    if (!state?.pending || !marker) {
      return originalRunTurn.call(session, message, ...args);
    }

    const instruction = marker.instruction
      ? `\n${marker.instruction}`
      : "";
    const markerContext =
      `[Chat marker: ${marker.icon} ${marker.title}]${instruction}\n` +
      "Treat this marker as session context. Do not mention the hidden marker unless it is relevant to the user's request.";
    const decoratedMessage = `${markerContext}\n\n${message}`;

    try {
      const result = await originalRunTurn.call(
        session,
        decoratedMessage,
        ...args
      );
      if (this.settings.sessionMarkers[key]?.markerId === marker.id) {
        this.settings.sessionMarkers[key].pending = false;
        this.queueSave();
      }
      return result;
    } catch (error) {
      throw error;
    }
  }

  rearmMarkerWhenSessionChanges() {
    const session = this.getActiveSession();
    const key = this.getSessionKey(session);
    if (!key || key === this.lastActiveSessionKey) return;

    this.lastActiveSessionKey = key;
    let state = this.settings.sessionMarkers[key];
    if (!state) {
      this.adoptMarkerFromTitle(session, key);
      state = this.settings.sessionMarkers[key];
    }
    if (state && !state.pending) {
      state.pending = true;
      this.queueSave();
    }
  }

  syncActiveStateFromTitle() {
    const session = this.getActiveSession();
    const key = this.getSessionKey(session);
    if (!session || !key) return;

    const marker = this.getMarkerFromLabel(session.getLabel?.() || "");
    const state = this.settings.sessionMarkers[key];
    if (!marker || state?.markerId === marker.id) return;

    this.settings.sessionMarkers[key] = {
      markerId: marker.id,
      baseLabel: this.stripKnownPrefix(session.getLabel?.() || ""),
      pending: true,
      updatedAt: Date.now(),
    };
    this.queueSave();
  }

  adoptMarkerFromTitle(session, key) {
    const label = session?.getLabel?.() || "";
    const marker = this.getMarkerFromLabel(label);
    if (!marker) return;

    this.settings.sessionMarkers[key] = {
      markerId: marker.id,
      baseLabel: label.slice(marker.icon.length).trimStart(),
      pending: true,
      updatedAt: Date.now(),
    };
    this.queueSave();
  }

  stripKnownPrefix(label) {
    const value = typeof label === "string" ? label : "";
    const match = this.getMarkerFromLabel(value);
    return match ? value.slice(match.icon.length).trimStart() : value;
  }

  async setActiveMarker(markerId) {
    this.refreshIntegration();
    if (!this.compatible || !this.manager) {
      new Notice(this.compatibilityMessage);
      return;
    }

    const marker = this.getMarker(markerId);
    const session = this.getActiveSession();
    const key = this.getSessionKey(session);
    const label = session?.getLabel?.() || "";

    if (!marker || !session || !key) {
      new Notice("Open a Copilot Agent chat before choosing a marker.");
      return;
    }

    if (!label.trim()) {
      new Notice("Send the first chat message before choosing a marker.");
      return;
    }

    const existing = this.settings.sessionMarkers[key];
    const baseLabel = existing?.baseLabel || this.stripKnownPrefix(label);
    this.settings.sessionMarkers[key] = {
      markerId: marker.id,
      baseLabel,
      pending: true,
      updatedAt: Date.now(),
    };

    const markedTitle = `${marker.icon} ${baseLabel}`;
    this.manager.renameSession(session.internalId, markedTitle);
    await this.manager.saveActiveSession();
    await this.updateHistoryTitle(session, markedTitle);
    await this.saveSettings();
    this.updateToolbarButtons();
    new Notice(`${marker.icon} ${marker.title}`);
  }

  async clearActiveMarker() {
    this.refreshIntegration();
    if (!this.compatible || !this.manager) {
      new Notice(this.compatibilityMessage);
      return;
    }

    const session = this.getActiveSession();
    const key = this.getSessionKey(session);
    if (!session || !key) {
      new Notice("Open a Copilot Agent chat before clearing its marker.");
      return;
    }

    const state = this.settings.sessionMarkers[key];
    const label = session.getLabel?.() || "";
    const baseLabel = state?.baseLabel || this.stripKnownPrefix(label);
    delete this.settings.sessionMarkers[key];
    this.manager.renameSession(session.internalId, baseLabel);
    await this.manager.saveActiveSession();
    await this.updateHistoryTitle(session, baseLabel);
    await this.saveSettings();
    this.updateToolbarButtons();
    new Notice("Chat marker cleared.");
  }

  async updateHistoryTitle(session, title) {
    const path = this.manager?.sessionState?.get(session?.internalId)?.path;
    if (!path || typeof this.manager?.updateChatTitle !== "function") return;
    await this.manager.updateChatTitle(path, title);
  }

  openMarkerMenu(event) {
    this.refreshIntegration();
    const menu = new Menu();
    const activeState = this.getActiveState();
    const activeTitleMarker = this.getMarkerFromLabel(
      this.getActiveSession()?.getLabel?.() || ""
    );

    for (const marker of this.settings.markers) {
      menu.addItem((item) => {
        item
          .setTitle(`${marker.icon} ${marker.title}`)
          .setChecked(
            (activeTitleMarker?.id || activeState?.markerId) === marker.id
          )
          .onClick(() => void this.setActiveMarker(marker.id));
      });
    }

    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("○ Clear marker")
        .setIcon("circle-off")
        .onClick(() => void this.clearActiveMarker());
    });
    menu.addItem((item) => {
      item
        .setTitle("Marker settings")
        .setIcon("settings")
        .onClick(() => {
          this.app.setting.open();
          this.app.setting.openTabById(PLUGIN_ID);
        });
    });

    if (event && typeof menu.showAtMouseEvent === "function") {
      menu.showAtMouseEvent(event);
    } else {
      menu.showAtPosition({ x: 48, y: 96 });
    }
  }

  injectToolbarButtons() {
    const views = document.querySelectorAll(
      `.workspace-leaf-content[data-type="${AGENT_VIEW_TYPE}"]`
    );

    for (const view of views) {
      let historyButton = view.querySelector('button[title="Chat History"]');
      if (!historyButton) {
        historyButton = view.querySelector("svg.lucide-history")?.closest("button");
      }
      if (!historyButton?.parentElement) continue;
      if (
        historyButton.parentElement.querySelector(
          ":scope > .copilot-chat-marker-button"
        )
      ) {
        continue;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "clickable-icon copilot-chat-marker-button tw-size-7 tw-text-faint";
      button.setAttribute("aria-label", "Mark current chat");
      button.title = "Mark current chat";
      button.addEventListener("click", (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        this.openMarkerMenu(clickEvent);
      });

      historyButton.parentElement.insertBefore(button, historyButton);
    }
  }

  updateToolbarButtons() {
    const state = this.getActiveState();
    const marker =
      this.getMarkerFromLabel(this.getActiveSession()?.getLabel?.() || "") ||
      (state ? this.getMarker(state.markerId) : null);
    const icon = marker?.icon || "◇";
    const title = marker
      ? `Chat marker: ${marker.icon} ${marker.title}`
      : "Mark current chat";

    document.querySelectorAll(".copilot-chat-marker-button").forEach((button) => {
      if (button.textContent !== icon) button.textContent = icon;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.classList.toggle("is-marked", Boolean(marker));
    });
  }

  queueSave() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveSettings();
    }, 150);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async resetMarkers() {
    this.settings.markers = cloneDefaults().markers;
    const validIds = new Set(this.settings.markers.map((marker) => marker.id));
    for (const [key, state] of Object.entries(this.settings.sessionMarkers)) {
      if (!validIds.has(state.markerId)) delete this.settings.sessionMarkers[key];
    }
    await this.saveSettings();
    this.updateToolbarButtons();
  }
}

class CopilotChatMarkerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Chat Marker for Copilot").setHeading();

    containerEl.createEl("p", {
      cls: "copilot-chat-marker-settings-intro",
      text:
        "Each marker has a visible icon and title plus a quiet instruction attached to the next agent message.",
    });

    const status = containerEl.createDiv({
      cls:
        "copilot-chat-marker-compatibility " +
        (this.plugin.compatible ? "is-compatible" : "is-incompatible"),
    });
    status.setText(this.plugin.compatibilityMessage);

    this.plugin.settings.markers.forEach((marker, index) => {
      const group = containerEl.createDiv({
        cls: "copilot-chat-marker-setting",
      });

      new Setting(group)
        .setName(`Marker ${index + 1}`)
        .setDesc(`${marker.icon || "◇"} ${marker.title}`)
        .addExtraButton((button) =>
          button
            .setIcon("arrow-up")
            .setTooltip("Move up")
            .setDisabled(index === 0)
            .onClick(async () => {
              const markers = this.plugin.settings.markers;
              [markers[index - 1], markers[index]] = [
                markers[index],
                markers[index - 1],
              ];
              await this.plugin.saveSettings();
              this.display();
            })
        )
        .addExtraButton((button) =>
          button
            .setIcon("arrow-down")
            .setTooltip("Move down")
            .setDisabled(index === this.plugin.settings.markers.length - 1)
            .onClick(async () => {
              const markers = this.plugin.settings.markers;
              [markers[index], markers[index + 1]] = [
                markers[index + 1],
                markers[index],
              ];
              await this.plugin.saveSettings();
              this.display();
            })
        )
        .addExtraButton((button) =>
          button
            .setIcon("trash")
            .setTooltip("Remove marker")
            .onClick(async () => {
              this.plugin.settings.markers.splice(index, 1);
              await this.plugin.saveSettings();
              this.plugin.updateToolbarButtons();
              this.display();
            })
        );

      new Setting(group).setName("Icon").addText((text) =>
        text.setValue(marker.icon).onChange(async (value) => {
          marker.icon = value.trim();
          await this.plugin.saveSettings();
          this.plugin.updateToolbarButtons();
        })
      );

      new Setting(group).setName("Title").addText((text) =>
        text.setValue(marker.title).onChange(async (value) => {
          marker.title = value.trim() || "Marker";
          await this.plugin.saveSettings();
        })
      );

      new Setting(group)
        .setName("Agent instruction")
        .setDesc("Quietly attached to the next real message.")
        .addTextArea((text) =>
          text.setValue(marker.instruction).onChange(async (value) => {
            marker.instruction = value.trim();
            await this.plugin.saveSettings();
          })
        );
    });

    new Setting(containerEl)
      .setName("Add marker")
      .setDesc("Create another icon, title, and instruction.")
      .addButton((button) =>
        button.setButtonText("Add").onClick(async () => {
          this.plugin.settings.markers.push({
            id: `marker-${Date.now().toString(36)}`,
            icon: "✨",
            title: "New marker",
            instruction: "",
          });
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Restore default markers")
      .setDesc("Restores the bundled marker list and instructions.")
      .addButton((button) =>
        button
          .setButtonText("Restore defaults")
          .setWarning()
          .onClick(async () => {
            await this.plugin.resetMarkers();
            this.display();
          })
      );
  }
}

module.exports = CopilotChatMarkerPlugin;
