// D7 pre-flight cost check (docs/ROADMAP.md D7): "log one real response.usage" from
// compileCriteria() to confirm the M2 Opus call clears 0.1 USDT with real margin - not yet
// measured as of D6.B. One real Opus call, same request shape compileCriteria() actually
// sends (model/thinking/effort/output_config/system prompt), against a real spec fixture.
// Throwaway diagnostic, same posture as scripts/probe-m2-bias.ts.
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { buildSystemPrompt, CompilerOutput } from "../src/modules/m2-criteria-compiler.js";

// Direct Anthropic key, read separately from src/config.js - compileCriteria() itself moved to
// OpenRouter (see m2-criteria-compiler.ts) once the direct Anthropic key ran out of credit, but
// this diagnostic still measures real Opus 4.8 pricing/margin for whenever real budget exists.
function requiredAnthropicApiKey(): string {
  const value = process.env.ANTHROPIC_API_KEY;
  if (!value) throw new Error("Missing required env var: ANTHROPIC_API_KEY");
  return value;
}

const OPUS_4_8_INPUT_PER_MTOK = 5.0;
const OPUS_4_8_OUTPUT_PER_MTOK = 25.0;

async function main() {
  const specPath = process.argv[2] ?? "scripts/fixtures/content-spec.txt";
  const spec = readFileSync(specPath, "utf8").trim();
  const canary = `measure-${Date.now()}`;

  const anthropic = new Anthropic({ apiKey: requiredAnthropicApiKey() });
  const message = await anthropic.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(CompilerOutput) },
    system: buildSystemPrompt(canary),
    messages: [
      {
        role: "user",
        content: `<order_spec>\n${spec}\n</order_spec>\n\nCompile this spec into criteria per the rules above.`,
      },
    ],
  });

  const usage = message.usage;
  const inputCost = (usage.input_tokens / 1_000_000) * OPUS_4_8_INPUT_PER_MTOK;
  const outputCost = (usage.output_tokens / 1_000_000) * OPUS_4_8_OUTPUT_PER_MTOK;
  const totalCost = inputCost + outputCost;

  console.log(`spec: ${specPath}`);
  console.log(`criteria compiled: ${message.parsed_output?.criteria.length ?? "parse failed"}`);
  console.log(`\nresponse.usage:`);
  console.log(JSON.stringify(usage, null, 2));
  console.log(`\ncost @ Opus 4.8 rates ($${OPUS_4_8_INPUT_PER_MTOK}/$${OPUS_4_8_OUTPUT_PER_MTOK} per MTok):`);
  console.log(`  input:  ${usage.input_tokens} tok = $${inputCost.toFixed(6)}`);
  console.log(`  output: ${usage.output_tokens} tok = $${outputCost.toFixed(6)}`);
  console.log(`  total:  $${totalCost.toFixed(6)}`);
  console.log(`\nflat price: 0.1 USDT/job. Margin: $${(0.1 - totalCost).toFixed(6)} (${(((0.1 - totalCost) / 0.1) * 100).toFixed(1)}%)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
