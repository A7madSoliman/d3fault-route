# d3fault-route

d3fault-route applies adaptive model routing to Agy, Codex, and Claude. For each fresh user turn, Jev recommends a provider-neutral tier, and the selected provider uses a compatible model while its conversation or session continues.

## Why d3fault-route

A quick question and a difficult coding task need different model strength, speed, and cost. d3fault-route makes that choice per turn so you can keep working in your chosen provider without manually switching models each time.

## How routing works

```text
User turn → Jev → fast / balanced / strong / long → provider-specific model
                                                     ↓
                                          same provider/session continues
```

A fresh turn can receive a new tier. Continuations within that turn keep its selected tier. An explicit native model choice uses manual passthrough.

## Supported providers

### Agy

`d3-agy` opens an interactive session with adaptive routing among supported Gemini models. It retains conversation context across turns, even when the selected model changes. Use `/model` for manual selection and `/auto` to resume routing. For a headless one-shot prompt, use `d3-agy -p "..."`.

### Codex

`d3-codex` routes fresh turns among supported GPT/Codex catalog models. Codex keeps its native CLI behavior, authentication, tools, and session handling. Selecting a concrete model in its picker pauses automatic routing.

### Claude

`d3-claude` routes fresh turns among supported Claude catalog models. Claude keeps its native CLI behavior, authentication, tools, and session handling. Tool-loop continuations keep the turn's selected tier. Selecting a concrete model in its picker pauses automatic routing.

## Routing tiers

| Tier | Intended use |
| --- | --- |
| `fast` | Lighter tasks where speed matters |
| `balanced` | General work |
| `strong` | More demanding work |
| `long` | The opt-in highest tier |

These tiers are provider-neutral decisions. Agy maps them to Gemini models, Codex to supported GPT/Codex models, and Claude to supported Claude models. The `long` tier requires `JEV_ALLOW_FABLE=1`.

## Quick start

Requires Node.js 20.12+, the native CLI for each provider you plan to use, and that provider's own authentication. After npm publication, install globally:

```bash
npm install -g d3fault-route
```

Configure your Jev key outside the repository with `d3-config key set`, then launch an interactive provider:

```bash
d3-agy
d3-codex
d3-claude
```

Without a Jev key, Codex and Claude launch without routing. See `d3-config key status` to check whether a key is configured.

## Usage

| Command | Purpose |
| --- | --- |
| `d3-agy` | Interactive Agy routing |
| `d3-codex` | Interactive Codex routing |
| `d3-claude` | Interactive Claude routing |
| `d3-config` | Show or change provider tier settings |
| `d3-explain` | Show a recorded routing decision when the CLI exposes a session ID, or when you supply one |

Agy also supports the secondary one-shot form:

```bash
d3-agy -p "Summarize this task"
```

`d3-explain <session-id>` reads a specific recorded decision. The bundled Claude `/jev-explain` and Codex `$jev-explain` skill triggers retain their compatibility names.

### Agy interactive commands

| Command | Action |
| --- | --- |
| `/help` | List interactive commands |
| `/auto` | Resume automatic routing |
| `/model <Gemini model slug>` | Use a supported Gemini model manually |
| `/exit` | End the session |

A manual slug includes its effort, for example `gemini-3.8-flash-low`. Ctrl+C while idle exits. During an active turn it requests cancellation and waits for the turn to settle. If an outcome is uncertain, Agy asks for an explicit recovery decision before continuing.

## Configuration

Start with `d3-config show` to see the current model and effort values. The following commands are supported:

```bash
d3-config show
d3-config set <provider> <tier> --model <model>
d3-config reset <provider> <tier>
d3-config key status
d3-config key set
```

For Agy, `--model` uses a model family and `--effort` sets a compatible effort; the interactive `/model` command instead takes the combined slug. These are examples accepted by the current catalog:

```bash
d3-config set agy fast --model gemini-3.8-flash --effort low
d3-config set agy strong --model gemini-3.8-flash --effort high
d3-config set codex fast --model gpt-5.6-luna
d3-config set codex strong --model gpt-5.6-sol
d3-config set claude fast --model claude-haiku-4-5-20251001
d3-config set claude strong --model claude-opus-5
```

Model IDs can change with provider catalogs; use `d3-config show` to inspect the current config and built-in defaults. Reset one tier with, for example, `d3-config reset codex fast`. Codex and Claude load external tier configuration when their routing session starts, so restart a running session after changing it.

Settings remain in `~/.jev-router/config.json`, and the user key file remains `~/.jev-router.env`. These are retained compatibility paths. `JEV_API_KEY` remains the key variable name.

## Provider isolation

Agy routes to Gemini only, Codex to supported GPT/Codex models only, and Claude to Claude models only. Cross-provider model configuration is rejected.

## Security and Windows behavior

Keep `JEV_API_KEY` and other secrets outside the repository; do not paste or commit them. User config and env files are external to the checkout. Provider launches use argument arrays instead of shell command strings. On Windows, unsafe batch-only launcher paths fail closed where required; use native executables.

## Architecture overview

A shared routing and policy core decides provider-neutral tiers. Provider-owned adapters validate model choices. Each provider keeps its own transport or process integration to preserve its session behavior.

## Development

From a local checkout, link the commands globally:

```bash
npm install
npm link
```

Run the test suite:

```bash
npm test
```

## License / Attribution

d3fault-route is distributed under the MIT License. Parts of this project originated from the MIT-licensed jev-router project by its original contributors and have since been substantially modified and extended. The required copyright and license notice remain in [LICENSE](LICENSE).
