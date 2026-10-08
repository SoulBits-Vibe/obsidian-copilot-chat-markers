const {
  Menu,
  Modal,
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
const CHAT_FOLDER = "system/copilot/copilot-conversations";

const DEFAULT_MARKERS = [
  {
    id: "important",
    icon: "⭐",
    title: "Important",
    instruction:
      "This chat is marked as important. Keep the main issue visible and prioritize it when relevant.",
  },
  {
    id: "question",
    icon: "❓",
    title: "Question",
    instruction:
      "An important question remains unresolved. Keep the uncertainty visible and help resolve it.",
  },
  {
    id: "idea",
    icon: "💡",
    title: "Idea",
    instruction:
      "Treat this as an idea to explore, not as a settled decision or commitment.",
  },
  {
    id: "in-progress",
    icon: "🚧",
    title: "In progress",
    instruction:
      "Work on this chat is in progress. Continue from the current state and keep unfinished steps visible.",
  },
  {
    id: "waiting",
    icon: "⏳",
    title: "Waiting",
    instruction:
      "This chat is waiting on information, a decision, or an external action. Keep the dependency visible and do not assume it is resolved.",
  },
  {
    id: "review",
    icon: "👀",
    title: "Review",
    instruction:
      "This chat needs review. Check the current material carefully and surface anything that needs attention or confirmation.",
  },
  {
    id: "done",
    icon: "✅",
    title: "Done",
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

function chatMatchesQuery(chat, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  return `${chat.title}\n${chat.content}`.toLowerCase().includes(needle);
}

function makeChatExcerpt(content, query, radius = 90) {
  const needle = query.trim().toLowerCase();
  const lower = content.toLowerCase();
  const index = lower.indexOf(needle);
  if (!needle || index < 0) return "";

  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + needle.length + radius);
  const excerpt = content
    .slice(start, end)
    .replace(/^---[\s\S]*?---\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < content.length ? "…" : ""}`;
}

class CopilotChatSearchModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.chats = [];
    this.selectedIndex = 0;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("copilot-chat-search-modal");
    contentEl.createEl("h2", { text: "Search Copilot chats" });

    this.inputEl = contentEl.createEl("input", {
      cls: "copilot-chat-search-input",
      attr: {
        type: "search",
        placeholder: "Search message text and titles…",
        "aria-label": "Search Copilot chat contents",
      },
    });
    this.statusEl = contentEl.createDiv({
      cls: "copilot-chat-search-status",
      text: "Loading Copilot chats…",
    });
    this.resultsEl = contentEl.createDiv({
      cls: "copilot-chat-search-results",
    });

    this.inputEl.addEventListener("input", () => {
      this.selectedIndex = 0;
      this.renderResults();
    });
    this.inputEl.addEventListener("keydown", (event) =>
      this.handleKeydown(event)
    );

    void this.loadChats();
    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }

  async loadChats() {
    try {
      const listing = await this.app.vault.adapter.list(CHAT_FOLDER);
      const paths = listing.files.filter((path) => path.endsWith(".md"));
      const chats = await Promise.all(
        paths.map(async (path) => {
          const content = await this.app.vault.adapter.read(path);
          const file = this.app.vault.getAbstractFileByPath(path);
          const frontmatter = file
            ? this.app.metadataCache.getFileCache(file)?.frontmatter
            : null;
          return {
            path,
            file,
            title:
              frontmatter?.topic ||
              frontmatter?.agentLabel ||
              file?.basename ||
              path.split("/").pop()?.replace(/\.md$/, "") ||
              path,
            content,
            modified: file?.stat?.mtime || 0,
          };
        })
      );
      this.chats = chats.sort((a, b) => b.modified - a.modified);
      this.statusEl.setText(`${this.chats.length} Copilot chats ready`);
      this.renderResults();
    } catch (error) {
      console.error("[Chat Marker] Failed to load Copilot chats", error);
      this.statusEl.setText(`Could not read ${CHAT_FOLDER}`);
    }
  }

  getMatches() {
    const query = this.inputEl?.value || "";
    if (!query.trim()) return [];
    return this.chats.filter((chat) => chatMatchesQuery(chat, query));
  }

  renderResults() {
    if (!this.resultsEl || !this.inputEl) return;
    this.resultsEl.empty();
    const query = this.inputEl.value;

    if (!query.trim()) {
      this.statusEl.setText(
        this.chats.length
          ? `${this.chats.length} Copilot chats ready`
          : "Loading Copilot chats…"
      );
      return;
    }

    const matches = this.getMatches();
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, matches.length - 1)
    );
    this.statusEl.setText(
      `${matches.length} ${matches.length === 1 ? "chat" : "chats"} found`
    );

    for (const [index, chat] of matches.entries()) {
      const result = this.resultsEl.createDiv({
        cls:
          "copilot-chat-search-result" +
          (index === this.selectedIndex ? " is-selected" : ""),
        attr: { tabindex: "0" },
      });
      result.createDiv({
        cls: "copilot-chat-search-result-title",
        text: chat.title,
      });
      result.createDiv({
        cls: "copilot-chat-search-result-date",
        text: chat.modified
          ? new Date(chat.modified).toLocaleString()
          : chat.path,
      });
      result.createDiv({
        cls: "copilot-chat-search-result-excerpt",
        text: makeChatExcerpt(chat.content, query),
      });
      result.addEventListener("mouseenter", () => {
        this.selectedIndex = index;
        this.updateSelection();
      });
      result.addEventListener("click", () => void this.openChat(chat));
      result.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void this.openChat(chat);
      });
    }
  }

  updateSelection() {
    this.resultsEl
      ?.querySelectorAll(".copilot-chat-search-result")
      .forEach((result, index) =>
        result.classList.toggle("is-selected", index === this.selectedIndex)
      );
  }

  handleKeydown(event) {
    const matches = this.getMatches();
    if (!matches.length) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.selectedIndex = Math.min(this.selectedIndex + 1, matches.length - 1);
      this.updateSelection();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.updateSelection();
    } else if (event.key === "Enter") {
      event.preventDefault();
      void this.openChat(matches[this.selectedIndex]);
    }
  }

  async openChat(chat) {
    try {
      const manager = this.plugin.getManager();
      if (chat.file && typeof manager?.loadSessionFromHistory === "function") {
        await manager.loadSessionFromHistory(chat.file);
        const leaf = this.app.workspace.getLeavesOfType(AGENT_VIEW_TYPE)[0];
        if (leaf) await this.app.workspace.revealLeaf(leaf);
      } else if (chat.file) {
        await this.app.workspace.getLeaf(true).openFile(chat.file);
      } else {
        throw new Error("Chat file is unavailable.");
      }
      this.close();
    } catch (error) {
      console.error("[Chat Marker] Failed to open Copilot chat", error);
      new Notice("Could not open that Copilot chat.");
    }
  }
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
    this.pendingMarkerRefreshIds = new Set();
    this.refreshFrame = null;
    this.chatSearchIndex = null;
    this.chatSearchIndexPromise = null;

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
    this.pendingMarkerRefreshIds.clear();
    if (this.refreshFrame) window.cancelAnimationFrame(this.refreshFrame);
    this.refreshScheduled = false;
    if (this.managerUnsubscribe) this.managerUnsubscribe();
    this.managerUnsubscribe = null;
    this.restorePatchedSessions();
    this.manager = null;
    document
      .querySelectorAll(".copilot-chat-marker-button")
      .forEach((button) => button.remove());
    document
      .querySelectorAll(".copilot-chat-inline-results")
      .forEach((results) => results.remove());
    document
      .querySelectorAll(".copilot-chat-search-native-hidden")
      .forEach((element) =>
        element.classList.remove("copilot-chat-search-native-hidden")
      );
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
        ? this.manager.subscribe(() => {
            this.chatSearchIndex = null;
            this.chatSearchIndexPromise = null;
            this.scheduleRefresh();
          })
        : null;
    }

    if (this.manager) {
      this.patchSessions();
      this.rearmMarkerWhenSessionChanges();
      this.syncActiveStateFromTitle();
    }

    this.injectToolbarButtons();
    this.updateToolbarButtons();
    this.integrateChatHistorySearch();
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
    if (!session || typeof this.manager?.updateChatTitle !== "function") return;

    const ids =
      typeof this.manager.recentChatIdsForSession === "function"
        ? this.manager.recentChatIdsForSession(session.internalId, session)
        : [
            this.manager.getSessionSourcePath?.(session.internalId) ||
              this.manager.sessionState?.get(session.internalId)?.path,
          ];

    for (const id of [...new Set(ids.filter(Boolean))]) {
      await this.manager.updateChatTitle(id, title);
    }
    this.manager.notify?.();
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

  integrateChatHistorySearch() {
    const inputs = document.querySelectorAll(
      `.workspace-leaf-content[data-type="${AGENT_VIEW_TYPE}"] input[placeholder="Search chats..."]`
    );

    for (const input of inputs) {
      const searchWrapper = input.closest(".tw-p-1");
      const root = searchWrapper?.parentElement;
      if (!searchWrapper || !root) continue;

      if (!input.dataset.copilotChatContentSearchBound) {
        input.dataset.copilotChatContentSearchBound = "true";
        input.addEventListener("input", () => {
          window.setTimeout(() => void this.renderChatHistorySearch(input), 0);
        });
        input.addEventListener("keydown", (event) =>
          this.handleChatHistorySearchKeydown(input, event)
        );
      }

      if (
        input.value.trim() &&
        !root.querySelector(":scope > .copilot-chat-inline-results")
      ) {
        void this.renderChatHistorySearch(input);
      }
    }
  }

  async loadChatSearchIndex() {
    if (this.chatSearchIndex) return this.chatSearchIndex;
    if (this.chatSearchIndexPromise) return this.chatSearchIndexPromise;

    this.chatSearchIndexPromise = (async () => {
      const manager = this.getManager();
      if (typeof manager?.getChatHistoryItems !== "function") return [];
      const projectId = manager.getActiveProjectId?.();
      const items = await manager.getChatHistoryItems(projectId);
      const chats = await Promise.all(
        items
          .filter(
            (item) =>
              typeof item?.id === "string" &&
              item.id.startsWith(`${CHAT_FOLDER}/`) &&
              item.id.endsWith(".md")
          )
          .map(async (item) => {
            const content = await this.app.vault.adapter.read(item.id);
            return {
              path: item.id,
              file: this.app.vault.getAbstractFileByPath(item.id),
              title: item.title || item.id,
              content,
              modified: new Date(
                item.lastAccessedAt || item.createdAt || 0
              ).getTime(),
            };
          })
      );
      this.chatSearchIndex = chats.sort((a, b) => b.modified - a.modified);
      this.chatSearchIndexPromise = null;
      return this.chatSearchIndex;
    })().catch((error) => {
      this.chatSearchIndexPromise = null;
      throw error;
    });

    return this.chatSearchIndexPromise;
  }

  clearChatHistorySearch(input) {
    const searchWrapper = input.closest(".tw-p-1");
    const root = searchWrapper?.parentElement;
    if (!root) return;
    root
      .querySelector(":scope > .copilot-chat-inline-results")
      ?.remove();
    root
      .querySelectorAll(":scope > .copilot-chat-search-native-hidden")
      .forEach((element) =>
        element.classList.remove("copilot-chat-search-native-hidden")
      );
    input.__copilotChatMatches = [];
    input.__copilotChatSelectedIndex = 0;
  }

  async renderChatHistorySearch(input) {
    const query = input.value.trim();
    if (!query) {
      this.clearChatHistorySearch(input);
      return;
    }

    const searchWrapper = input.closest(".tw-p-1");
    const root = searchWrapper?.parentElement;
    if (!searchWrapper || !root) return;

    let chats;
    try {
      chats = await this.loadChatSearchIndex();
    } catch (error) {
      console.error("[Chat Marker] Failed to search Copilot chats", error);
      new Notice("Could not search Copilot chat contents.");
      return;
    }
    if (input.value.trim() !== query) return;

    const matches = chats.filter((chat) => chatMatchesQuery(chat, query));
    input.__copilotChatMatches = matches;
    input.__copilotChatSelectedIndex = Math.min(
      input.__copilotChatSelectedIndex || 0,
      Math.max(0, matches.length - 1)
    );

    root
      .querySelector(":scope > .copilot-chat-inline-results")
      ?.remove();
    const results = document.createElement("div");
    results.className = "copilot-chat-inline-results";
    results.setAttribute("aria-live", "polite");
    searchWrapper.insertAdjacentElement("afterend", results);

    for (const child of root.children) {
      if (child !== searchWrapper && child !== results) {
        child.classList.add("copilot-chat-search-native-hidden");
      }
    }

    if (!matches.length) {
      results.createDiv({
        cls: "copilot-chat-inline-empty",
        text: "No matching chat contents",
      });
      return;
    }

    for (const [index, chat] of matches.entries()) {
      const row = results.createDiv({
        cls:
          "copilot-chat-inline-result" +
          (index === input.__copilotChatSelectedIndex ? " is-selected" : ""),
        attr: { tabindex: "0" },
      });
      row.createDiv({
        cls: "copilot-chat-inline-title",
        text: chat.title,
      });
      row.createDiv({
        cls: "copilot-chat-inline-date",
        text: chat.modified ? new Date(chat.modified).toLocaleString() : chat.path,
      });
      row.createDiv({
        cls: "copilot-chat-inline-excerpt",
        text: makeChatExcerpt(chat.content, query),
      });
      row.addEventListener("mouseenter", () => {
        input.__copilotChatSelectedIndex = index;
        this.updateChatHistorySearchSelection(input);
      });
      row.addEventListener("click", () => void this.openChatSearchResult(chat));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void this.openChatSearchResult(chat);
      });
    }
  }

  updateChatHistorySearchSelection(input) {
    const searchWrapper = input.closest(".tw-p-1");
    const root = searchWrapper?.parentElement;
    root
      ?.querySelectorAll(
        ":scope > .copilot-chat-inline-results .copilot-chat-inline-result"
      )
      .forEach((result, index) =>
        result.classList.toggle(
          "is-selected",
          index === input.__copilotChatSelectedIndex
        )
      );
  }

  handleChatHistorySearchKeydown(input, event) {
    const matches = input.__copilotChatMatches || [];
    if (!matches.length) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      input.__copilotChatSelectedIndex = Math.min(
        (input.__copilotChatSelectedIndex || 0) + 1,
        matches.length - 1
      );
      this.updateChatHistorySearchSelection(input);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      input.__copilotChatSelectedIndex = Math.max(
        (input.__copilotChatSelectedIndex || 0) - 1,
        0
      );
      this.updateChatHistorySearchSelection(input);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void this.openChatSearchResult(
        matches[input.__copilotChatSelectedIndex || 0]
      );
    }
  }

  async openChatSearchResult(chat) {
    try {
      const manager = this.getManager();
      if (!chat.file || typeof manager?.loadSessionFromHistory !== "function") {
        throw new Error("Copilot chat loader is unavailable.");
      }
      await manager.loadSessionFromHistory(chat.file);
      const leaf = this.app.workspace.getLeavesOfType(AGENT_VIEW_TYPE)[0];
      if (leaf) await this.app.workspace.revealLeaf(leaf);
    } catch (error) {
      console.error("[Chat Marker] Failed to open Copilot chat", error);
      new Notice("Could not open that Copilot chat.");
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
      const parent = historyButton.parentElement;
      if (!parent.querySelector(":scope > .copilot-chat-marker-button")) {
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

        parent.insertBefore(button, historyButton);
      }
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

  queueSave(markerId = null) {
    if (markerId) this.pendingMarkerRefreshIds.add(markerId);
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(async () => {
      this.saveTimer = null;
      await this.saveSettings();
      const markerIds = [...this.pendingMarkerRefreshIds];
      this.pendingMarkerRefreshIds.clear();
      for (const pendingMarkerId of markerIds) {
        await this.refreshActiveMarkerTitle(pendingMarkerId);
      }
    }, 150);
  }

  async refreshActiveMarkerTitle(markerId) {
    const marker = this.getMarker(markerId);
    const session = this.getActiveSession();
    const state = this.getActiveState();
    if (!marker || !session || state?.markerId !== markerId || !this.manager) {
      return;
    }

    const markedTitle = `${marker.icon} ${state.baseLabel}`.trimStart();
    this.manager.renameSession(session.internalId, markedTitle);
    await this.manager.saveActiveSession();
    await this.updateHistoryTitle(session, markedTitle);
    this.updateToolbarButtons();
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

      const markerHeading = new Setting(group)
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

      const refreshMarkerHeading = () =>
        markerHeading.setDesc(`${marker.icon || "◇"} ${marker.title}`);

      new Setting(group)
        .setName("Icon")
        .setDesc(
          "Use a Unicode emoji. Open the emoji picker with Control–Command–Space on macOS or Windows key + . (period) on Windows. On Linux, use your desktop's emoji picker or paste an emoji. The stars on a new marker are only a placeholder."
        )
        .addText((text) =>
          text.setValue(marker.icon).onChange(async (value) => {
            marker.icon = value.trim();
            refreshMarkerHeading();
            this.plugin.updateToolbarButtons();
            this.plugin.queueSave(marker.id);
          })
        );

      new Setting(group).setName("Title").addText((text) =>
        text.setValue(marker.title).onChange((value) => {
          marker.title = value.trim() || "Marker";
          refreshMarkerHeading();
          this.plugin.updateToolbarButtons();
          this.plugin.queueSave();
        })
      );

      new Setting(group)
        .setName("Agent instruction")
        .setDesc("Quietly attached to the next real message.")
        .addTextArea((text) =>
          text.setValue(marker.instruction).onChange((value) => {
            marker.instruction = value.trim();
            this.plugin.queueSave();
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

CopilotChatMarkerPlugin._test = { chatMatchesQuery, makeChatExcerpt };

module.exports = CopilotChatMarkerPlugin;
