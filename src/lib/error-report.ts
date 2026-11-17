/**
 * One place that turns any thrown value into a readable report.
 *
 * The crawl pipeline is an Effect program, and `Effect.runPromise` throws a
 * `FiberFailure` whose own `message` is the generic "An error has occurred"
 * (a `Data.TaggedError` starts with an empty message). The actionable text
 * and the stack live in the failure's cause, which is attached under a
 * symbol and can be a plain `{ _tag: "Fail", error }` record, a real
 * `Cause`, or a chain of `Error.cause` links.
 *
 * `briefError` gives the one line a table or log wants; `errorReport` gives
 * the multi-line chain plus stack traces that /sources shows on expand and
 * that `crawl_runs.error_detail` stores. Nothing here imports the crawler,
 * so scripts and routes can use it too.
 */

import { Cause } from "effect";

/** Effect's placeholder text, never worth showing instead of the real cause. */
const GENERIC_MESSAGES = new Set([
	"",
	"an error has occurred",
	"error",
	"crawlerror",
	"unknown error",
]);

/** Enough for a deep cause chain, small enough to persist per run. */
const MAX_DETAIL_CHARS = 8_000;
/** Stack frames per node: the trace head is what identifies the failure. */
const MAX_STACK_LINES = 12;

// biome-ignore lint/complexity/useRegexLiterals: the ESC escape is rejected by noControlCharactersInRegex in a literal
const ANSI = new RegExp("\\u001b\\[[0-9;]*m", "gu");

export interface ErrorReport {
	/** Single actionable line, safe for a table cell. */
	message: string;
	/** Multi-line cause chain and stacks, without colour codes. */
	detail: string;
}

interface CauseNode {
	label: string;
	message: string | null;
	stack: string | null;
}

/** Keys that can carry the next cause, across Error/Effect/plain shapes. */
const CAUSE_KEYS = [
	"cause",
	"error",
	"defect",
	"failure",
	"failures",
	"left",
	"right",
	"reason",
	"errors",
] as const;

/** The Cause a FiberFailure hides under a symbol, if this value has one. */
function fiberCause(value: unknown): unknown {
	if (!value || typeof value !== "object") return undefined;
	for (const symbol of Object.getOwnPropertySymbols(value)) {
		// `String(symbol)` renders as `Symbol(effect/Runtime/FiberFailure/Cause)`.
		if (!String(symbol).includes("FiberFailure/Cause")) continue;
		return (value as Record<symbol, unknown>)[symbol];
	}
	return undefined;
}

function cleanStack(stack: string): string {
	return stack
		.replace(ANSI, "")
		.split("\n")
		.filter((line) => line.trim())
		.slice(0, MAX_STACK_LINES)
		.join("\n");
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.find((line) => line.trim())
			?.trim() ?? ""
	);
}

/**
 * Walk the failure graph breadth-first, collecting every message and stack.
 * A node is visited once, so a self-referencing `cause` cannot loop.
 */
function collectNodes(root: unknown): CauseNode[] {
	const nodes: CauseNode[] = [];
	const seen = new Set<unknown>();
	const queue: unknown[] = [];

	const enqueue = (value: unknown): void => {
		if (value == null) return;
		if (Array.isArray(value)) {
			for (const item of value) queue.push(item);
			return;
		}
		if (typeof value === "object" || typeof value === "string")
			queue.push(value);
	};

	enqueue(fiberCause(root));
	enqueue(root);

	while (queue.length > 0 && nodes.length < 32) {
		const value = queue.shift();
		if (value == null || seen.has(value)) continue;
		if (typeof value === "object") seen.add(value);

		if (Cause.isCause(value)) {
			// A real Effect Cause: squash it to the original error and let the
			// walk continue through that error's own chain.
			enqueue(Cause.squash(value));
			continue;
		}

		if (typeof value === "string") {
			nodes.push({ label: "message", message: value.trim(), stack: null });
			continue;
		}

		if (value instanceof Error) {
			const message = value.message?.trim() || null;
			const label = value.constructor?.name ?? "Error";
			nodes.push({
				label,
				message,
				stack: value.stack ? cleanStack(value.stack) : null,
			});
			enqueue(value.cause);
			for (const key of CAUSE_KEYS) {
				if (key === "cause") continue;
				const nested: unknown = (value as unknown as Record<string, unknown>)[
					key
				];
				if (nested !== undefined && nested !== value) enqueue(nested);
			}
			continue;
		}

		if (typeof value === "object") {
			const record = value as Record<string, unknown>;
			const tag = typeof record._tag === "string" ? record._tag : null;
			// Cause nodes carry their payload under a tag-specific key; the
			// generic walk below picks it up.
			if (tag && !("message" in record)) {
				for (const key of CAUSE_KEYS) enqueue(record[key]);
				continue;
			}
			const rawMessage =
				typeof record.message === "string" ? record.message.trim() : null;
			if (rawMessage) {
				nodes.push({ label: tag ?? "error", message: rawMessage, stack: null });
			}
			for (const key of CAUSE_KEYS) enqueue(record[key]);
			if (typeof record.stack === "string") {
				const last = nodes[nodes.length - 1];
				if (last && !last.stack) last.stack = cleanStack(record.stack);
			}
		}
	}

	return nodes;
}

function isGeneric(message: string | null): boolean {
	return message == null || GENERIC_MESSAGES.has(message.toLowerCase());
}

/** Deepest non-generic message, else the first message, else `fallback`. */
function pickMessage(nodes: readonly CauseNode[], fallback: string): string {
	for (let i = nodes.length - 1; i >= 0; i--) {
		const message = nodes[i]?.message;
		if (message && !isGeneric(message)) return firstLine(message);
	}
	for (const node of nodes) {
		const message = node.message?.trim();
		if (message) return firstLine(message);
	}
	return fallback;
}

/** One actionable line for a log or a table cell. */
export function briefError(error: unknown): string {
	const nodes = collectNodes(error);
	return pickMessage(
		nodes,
		typeof error === "string" ? error : "unknown error",
	);
}

/**
 * Message plus the full cause chain and the stack traces behind it.
 *
 * The shape is deliberately plain text: it is stored in SQLite and rendered
 * inside a `<pre>`, so no ANSI codes and no JSON escaping.
 */
export function errorReport(error: unknown, context?: string): ErrorReport {
	const nodes = collectNodes(error);
	const message = pickMessage(nodes, "unknown error");
	const withContext = context ? `${context}: ${message}` : message;

	const chain = nodes
		.filter((node) => node.message)
		.map(
			(node, i) => `${i + 1}. ${node.label}: ${firstLine(node.message ?? "")}`,
		);

	const stacks = nodes
		.filter((node): node is CauseNode & { stack: string } =>
			Boolean(node.stack),
		)
		.map((node) => node.stack)
		.filter((stack, i, all) => all.indexOf(stack) === i);

	const sections = [
		`message: ${withContext}`,
		chain.length > 0 ? `cause chain:\n${chain.join("\n")}` : null,
		stacks.length > 0 ? `stack:\n${stacks.join("\n\n")}` : null,
	].filter((section): section is string => section != null);

	const detail = sections.join("\n\n");
	return {
		message: withContext,
		detail:
			detail.length > MAX_DETAIL_CHARS
				? `${detail.slice(0, MAX_DETAIL_CHARS)}\n… truncated`
				: detail,
	};
}
