// Claude calls: triage (is this a bug?) and duplicate matching.
import Anthropic from "@anthropic-ai/sdk";
import {
  TRIAGE_SYSTEM_PROMPT,
  TRIAGE_SCHEMA,
  DEDUPE_SYSTEM_PROMPT,
  DEDUPE_SCHEMA,
} from "./prompts.js";

// Reads ANTHROPIC_API_KEY from the environment.
const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

/**
 * Sends one request with a JSON-schema-constrained response and returns the
 * parsed object, or null if the model declined or the output was cut off.
 */
async function askForJson(system, userContent, schema, maxTokens) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userContent }],
    output_config: {
      // Classification is a simple task; low effort keeps latency and cost down.
      effort: "low",
      format: { type: "json_schema", schema },
    },
    // If a safety classifier declines the request, the API retries it on a
    // fallback model inside the same call instead of failing outright.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });

  if (response.stop_reason === "refusal") {
    console.warn("[llm] Request refused:", response.stop_details?.category ?? "unknown");
    return null;
  }
  if (response.stop_reason === "max_tokens") {
    console.warn("[llm] Response hit max_tokens; output is incomplete.");
    return null;
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return JSON.parse(text);
}

/**
 * Classifies a Discord message.
 * @returns {Promise<{is_bug: boolean, bug_title: string, search_query: string, issue_body: string} | null>}
 */
export async function triageMessage(messageText) {
  const content = `<discord_message>\n${messageText}\n</discord_message>`;
  return askForJson(TRIAGE_SYSTEM_PROMPT, content, TRIAGE_SCHEMA, 8000);
}

/**
 * Picks which (if any) of the candidate issues is a duplicate of the new report.
 * @returns {Promise<number | null>} the duplicate's issue number, or null if none.
 */
export async function findDuplicate(triage, candidates) {
  const candidateText = candidates
    .map(
      (issue) =>
        `<issue number="${issue.number}">\nTitle: ${issue.title}\n\n${(issue.body ?? "").slice(0, 1500)}\n</issue>`,
    )
    .join("\n\n");

  const content =
    `<new_report>\nTitle: ${triage.bug_title}\n\n${triage.issue_body}\n</new_report>\n\n` +
    `<candidate_issues>\n${candidateText}\n</candidate_issues>`;

  const result = await askForJson(DEDUPE_SYSTEM_PROMPT, content, DEDUPE_SCHEMA, 4000);
  const number = result?.duplicate_issue_number ?? 0;
  // Guard against the model returning a number that wasn't in the candidate list.
  return candidates.some((issue) => issue.number === number) ? number : null;
}
