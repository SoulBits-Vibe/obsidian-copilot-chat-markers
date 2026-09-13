const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Menu: class {},
      Notice: class {},
      Plugin: class {},
      PluginSettingTab: class {},
      Setting: class {},
      setIcon() {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const ChatMarkerPlugin = require("./main.js");
Module._load = originalLoad;

async function run() {
  const plugin = new ChatMarkerPlugin();
  plugin.settings = {
    markers: [
      {
        id: "idea",
        icon: "💡",
        title: "Worth revisiting",
        instruction: "Treat this as an idea, not a decision.",
      },
    ],
    sessionMarkers: {
      "codex:session-1": {
        markerId: "idea",
        baseLabel: "A useful conversation",
        pending: true,
      },
    },
  };
  plugin.queueSave = () => {};

  const session = {
    backendId: "codex",
    internalId: "internal-1",
    getBackendSessionId: () => "session-1",
    getLabel: () => "💡 A useful conversation",
  };

  assert.equal(plugin.getSessionKey(session), "codex:session-1");
  assert.equal(
    plugin.stripKnownPrefix("💡 A useful conversation"),
    "A useful conversation"
  );

  let backendMessage = "";
  const result = await plugin.runTurnWithMarker(
    session,
    async function (message) {
      backendMessage = message;
      return "ok";
    },
    "What should we do next?",
    []
  );

  assert.equal(result, "ok");
  assert.match(backendMessage, /Chat marker: 💡 Worth revisiting/);
  assert.match(backendMessage, /Treat this as an idea, not a decision/);
  assert.match(backendMessage, /What should we do next\?$/);
  assert.equal(
    plugin.settings.sessionMarkers["codex:session-1"].pending,
    false
  );

  plugin.settings.sessionMarkers["codex:session-1"] = {
    markerId: "progress",
    baseLabel: "A useful conversation",
    pending: true,
  };
  plugin.settings.markers.unshift({
    id: "progress",
    icon: "👍",
    title: "Progress",
    instruction: "Continue in the current direction.",
  });

  backendMessage = "";
  await plugin.runTurnWithMarker(
    session,
    async function (message) {
      backendMessage = message;
      return "ok";
    },
    "Title wins",
    []
  );

  assert.match(backendMessage, /Chat marker: 💡 Worth revisiting/);
  assert.equal(
    plugin.settings.sessionMarkers["codex:session-1"].markerId,
    "idea"
  );

  let renamedTitle = "";
  let historyTitle = "";
  plugin.manager = {
    getActiveSession: () => session,
    renameSession: (_internalId, title) => {
      renamedTitle = title;
    },
    saveActiveSession: async () => {},
  };
  plugin.updateHistoryTitle = async (_session, title) => {
    historyTitle = title;
  };
  plugin.updateToolbarButtons = () => {};
  plugin.settings.markers.find((marker) => marker.id === "idea").icon = "🧩";

  await plugin.refreshActiveMarkerTitle("idea");

  assert.equal(renamedTitle, "🧩 A useful conversation");
  assert.equal(historyTitle, "🧩 A useful conversation");

  console.log("Chat Marker core tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
