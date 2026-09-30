export const DEFAULT_MODEL_CONFIG = {
  claude: {
    fast: {
      model: "claude-haiku-4-5-20251001",
    },
    balanced: {
      model: "claude-sonnet-5",
    },
    strong: {
      model: "claude-opus-5",
    },
    long: {
      model: "claude-fable-5-1",
    },
  },

  codex: {
    fast: {
      model: "gpt-5.6-luna",
    },
    balanced: {
      model: "gpt-5.6-terra",
    },
    strong: {
      model: "gpt-5.6-sol",
    },
    long: {
      model: "gpt-6-astra",
    },
  },

  agy: {
    fast: {
      model: "gemini-3.8-flash",
      effort: "low",
    },
    balanced: {
      model: "gemini-3.8-flash",
      effort: "medium",
    },
    strong: {
      model: "gemini-3.8-flash",
      effort: "high",
    },
    long: {
      model: "gemini-3.1-pro",
      effort: "high",
    },
  },
};
