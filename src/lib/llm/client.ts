/**
 * Listings are interpreted by a model instead of hand-written patterns: a
 * seller writes "ogrzewanie z sieci miejskiej, po generalnym remoncie" and the
 * model turns that into the enums the scoring layer already uses.
 *
 * Transport goes through TanStack AI (`chat` + the OpenAI-compatible adapter)
 * rather than a hand-rolled fetch, so the provider layer stays swappable: the
 * adapter takes `baseURL`, `apiKey` and `defaultHeaders`, which is all this
 * backend needs.
 *
 * Configuration (only the key is required):
 * - `OPENCODE_GO_API_KEY`  API key, the same one jcode/opencode use.
 * - `LLM_API_BASE`         default `https://opencode.ai/inference/go/v1`.
 * - `LLM_MODEL`            default `hy4-flash-free` (free tier).
 *
 * The OpenCode Go endpoint rejects requests without a non-generic
 * User-Agent and an `x-opencode-session` header (Cloudflare answers 403
 * "error code: 1010"), so both are set on every call.
 */
import { chat } from "@tanstack/ai";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";

const DEFAULT_BASE = "https://opencode.ai/inference/go/v1";
const DEFAULT_MODEL = "hy4-flash-free";
const USER_AGENT = "flat-tracker/1.0";

/** A session id per process keeps routing and prompt caching warm. */
const SESSION_ID = crypto.randomUUID();

/**
 * Deadline for one model request.
 *
 * Fact extraction now sits on the crawl's critical path (facts are read before
 * the offer is stored), so a provider that accepts a connection and never
 * answers must not hold a site's crawl open. The adapter takes a custom
 * `fetch`, which is where the signal is attached: the abort surfaces as a
 * normal request error, the batch fails, the offers are stored without facts
 * and the repair phase retries them later.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);

/** `fetch` with a hard deadline, composed with any caller signal. */
const fetchWithTimeout: typeof fetch = (input, init) => {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(
			new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS} ms`),
		);
	}, REQUEST_TIMEOUT_MS);
	const caller = init?.signal;
	if (caller) {
		if (caller.aborted) controller.abort(caller.reason);
		else {
			caller.addEventListener("abort", () => controller.abort(caller.reason), {
				once: true,
			});
		}
	}
	return fetch(input, { ...init, signal: controller.signal }).finally(() =>
		clearTimeout(timer),
	);
};

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export interface ChatTextOptions {
	model?: string;
	/** System instructions: passed separately, the adapter keeps roles apart. */
	systemPrompt?: string;
	messages: ChatMessage[];
	/** Conversation id; a random one per call when omitted. */
	threadId?: string;
	/** Retries after the first attempt, on 429/5xx/timeout only. */
	retries?: number;
}

export class LlmError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "LlmError";
	}
}

export function llmModel(): string {
	return process.env.LLM_MODEL?.trim() || DEFAULT_MODEL;
}

/** The key is the only hard requirement; everything else has a default. */
export function llmConfigured(): boolean {
	return Boolean(process.env.OPENCODE_GO_API_KEY?.trim());
}

function apiBase(): string {
	const base = process.env.LLM_API_BASE?.trim() || DEFAULT_BASE;
	return base.replace(/\/+$/u, "");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Throttling and gateway hiccups are worth a retry, a 4xx body is not. */
function retryable(error: unknown): boolean {
	if (error instanceof LlmError) {
		const status = error.status ?? 0;
		return status === 408 || status === 409 || status === 429 || status >= 500;
	}
	// Network errors, DNS failures and aborts arrive as plain Errors.
	return true;
}

function toLlmError(error: unknown, model: string): LlmError {
	if (error instanceof LlmError) return error;
	const message = error instanceof Error ? error.message : String(error);
	const status = Number(
		message.match(/\b(4\d{2}|5\d{2})\b/u)?.[1] ?? Number.NaN,
	);
	return new LlmError(
		`${model}: ${message}`,
		Number.isFinite(status) ? status : undefined,
	);
}

/**
 * One chat completion. The answer is plain text that the caller parses and
 * validates: the model is a data source, not a trusted one.
 */
export async function chatText(options: ChatTextOptions): Promise<string> {
	const key = process.env.OPENCODE_GO_API_KEY?.trim();
	if (!key) {
		throw new LlmError(
			"OPENCODE_GO_API_KEY is not set: add it to .env.local to enable LLM fact extraction",
		);
	}
	const model = options.model?.trim() || llmModel();
	const retries = options.retries ?? 2;
	const adapter = openaiCompatibleText(model, {
		baseURL: apiBase(),
		apiKey: key,
		fetch: fetchWithTimeout,
		defaultHeaders: {
			"User-Agent": USER_AGENT,
			"x-opencode-session": SESSION_ID,
		},
	});

	let lastError: unknown = null;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt > 0) await sleep(1500 * 2 ** (attempt - 1));
		try {
			const result = await chat({
				adapter,
				systemPrompts: options.systemPrompt
					? [options.systemPrompt]
					: undefined,
				messages: options.messages,
				threadId: options.threadId ?? crypto.randomUUID(),
				stream: false,
				// Hy4 reasons by default, which triples latency on an
				// extraction task that needs no deliberation.
				modelOptions: { temperature: 0, reasoning_effort: "none" },
			});
			const text = result.text.trim();
			if (!text) {
				lastError = new LlmError(`${model} returned an empty answer`);
				continue;
			}
			return text;
		} catch (error) {
			const failure = toLlmError(error, model);
			lastError = failure;
			if (!retryable(failure)) throw failure;
		}
	}
	throw lastError instanceof Error
		? lastError
		: new LlmError(`${model}: request failed`);
}
