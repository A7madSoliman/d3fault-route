try {
  process.loadEnvFile();
} catch {
  // No .env; the key may still come from the real environment.
}
const { askJev } = await import("../src/router.mjs");
const { TIERS } = await import("../src/config.mjs");
const models = TIERS.map(({ id, name }) => ({ id, tier: name, description: id }));
const prompts = [
  "fix the typo 'recieve' in README.md",
  "add a unit test for the existing formatDate helper",
  "users intermittently get logged out after deploy, figure out why",
  "migrate the entire monorepo from webpack to vite",
];
for (const prompt of prompts) {
  const a = await askJev({ prompt, current: TIERS[1].id, contextTokens: 0, models });
  if (!a) { console.log(`FAIL  ${prompt}`); continue; }
  const p = Object.entries(a.probabilities).map(([k,v]) => `${k}=${v.toFixed(2)}`).join(" ");
  console.log(`${a.choice.padEnd(7)} conf=${a.confidence.toFixed(2)} ${String(a.ms).padStart(5)}ms | ${p} | ${prompt}`);
}
