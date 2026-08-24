import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

interface LastRun {
	startedAt: string | null;
	finishedAt: string | null;
	pages: number | null;
	newCount: number | null;
	updatedCount: number | null;
	error: string | null;
}

interface LiveState {
	source: string;
	state: "pending" | "running" | "ok" | "failed";
	pages?: number;
	newCount?: number;
	updatedCount?: number;
	error?: string;
}

interface SourceStatus {
	id: string;
	name: string;
	kind: "portal" | "rcn" | "geocode" | "airbnb-calendar";
	lastRun: LastRun | null;
	live: LiveState | null;
}

interface CrawlStatusResponse {
	running: boolean;
	progress: {
		runId: string;
		status: string;
		startedAt: string;
		finishedAt: string | null;
		phase: string;
	} | null;
	sources: SourceStatus[];
}

const STALE_MS = 24 * 60 * 60 * 1000;

function relativeTime(iso: string | null | undefined): string {
	if (!iso) return "never";
	const diff = Date.now() - new Date(iso).getTime();
	if (diff < 0) return "just now";
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

function duration(
	startedAt: string | null | undefined,
	finishedAt: string | null | undefined,
): string {
	if (!startedAt || !finishedAt) return "";
	const s =
		(new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000;
	if (s < 0) return "";
	if (s < 60) return `${s.toFixed(0)}s`;
	return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}

function dotClass(s: SourceStatus): string {
	if (s.live) {
		switch (s.live.state) {
			case "running":
				return "bg-blue-500 animate-pulse";
			case "failed":
				return "bg-red-500";
			case "ok":
				return "bg-green-500";
			default:
				return "bg-gray-400";
		}
	}
	const last = s.lastRun;
	if (!last) return "bg-gray-400";
	if (last.error) return "bg-red-500";
	if (
		last.finishedAt &&
		Date.now() - new Date(last.finishedAt).getTime() > STALE_MS
	) {
		return "bg-red-500";
	}
	return "bg-green-500";
}

function statusLabel(s: SourceStatus): string {
	if (s.live) {
		switch (s.live.state) {
			case "running":
				return "crawling…";
			case "failed":
				return "failed";
			case "ok":
				return "just updated";
			case "pending":
				return "queued";
		}
	}
	const last = s.lastRun;
	if (!last) return "never run";
	if (last.error) return "last run failed";
	if (
		last.finishedAt &&
		Date.now() - new Date(last.finishedAt).getTime() > STALE_MS
	) {
		return "stale";
	}
	return "ok";
}

function metrics(s: SourceStatus): string {
	if (s.live?.state === "running") return "crawling…";
	if (s.live?.state === "pending") return "queued";
	const run = s.lastRun;
	if (!run) return "—";
	const n = run.newCount ?? 0;
	const u = run.updatedCount ?? 0;
	const p = run.pages ?? 0;
	switch (s.kind) {
		case "rcn":
			return `${n} new transactions`;
		case "geocode":
			return `${n} geocoded`;
		case "airbnb-calendar":
			return `${n} listings · ${u} monthly rows`;
		default:
			return `${p} pages · ${n} new · ${u} updated`;
	}
}

export const Route = createFileRoute("/sources")({ component: SourcesPage });

function SourcesPage() {
	const queryClient = useQueryClient();
	const { data } = useQuery<CrawlStatusResponse>({
		queryKey: ["crawl-status"],
		queryFn: () => fetch("/api/crawl-status").then((r) => r.json()),
		refetchInterval: (query) => (query.state.data?.running ? 2000 : 15000),
	});
	const refresh = useMutation({
		mutationFn: async () => {
			const res = await fetch("/api/refresh", { method: "POST" });
			return (await res.json()) as {
				started: boolean;
				alreadyRunning: boolean;
			};
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["crawl-status"] });
		},
	});

	const running = data?.running ?? false;
	const sources = data?.sources ?? [];
	const doneCount = sources.filter(
		(s) => s.live?.state === "ok" || s.live?.state === "failed",
	).length;
	const pct =
		sources.length > 0 ? Math.round((doneCount / sources.length) * 100) : 0;

	return (
		<div className="mx-auto max-w-4xl p-8">
			<header className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-bold">Data sources</h1>
					<p className="mt-1 text-sm text-gray-600">
						Last refresh per source. Sources older than 24h turn red.
					</p>
				</div>
				<div className="flex items-center gap-3">
					<span className="text-sm text-gray-500">
						{running ? "Refresh in progress…" : "Idle"}
					</span>
					<button
						type="button"
						onClick={() => refresh.mutate()}
						disabled={running || refresh.isPending}
						className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{running ? "Running…" : "Refresh now"}
					</button>
				</div>
			</header>

			{running && (
				<div className="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
					<div className="flex items-center justify-between text-sm">
						<span className="font-medium">
							Phase: {data?.progress?.phase ?? "crawl"}
						</span>
						<span className="text-gray-600">
							{doneCount}/{sources.length} sources
						</span>
					</div>
					<div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-blue-100">
						<div
							className="h-full rounded-full bg-blue-500 transition-all"
							style={{ width: `${pct}%` }}
						/>
					</div>
				</div>
			)}

			{refresh.data?.alreadyRunning && (
				<p className="mt-3 text-sm text-amber-700">
					A refresh is already running; showing its live progress.
				</p>
			)}
			{refresh.isError && (
				<p className="mt-3 text-sm text-red-600">
					Failed to start refresh. Try again.
				</p>
			)}

			<div className="mt-6 overflow-hidden rounded-xl border">
				<table className="w-full text-sm">
					<thead>
						<tr className="border-b bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
							<th className="px-4 py-2 font-medium">Source</th>
							<th className="px-4 py-2 font-medium">Last refreshed</th>
							<th className="px-4 py-2 font-medium">Duration</th>
							<th className="px-4 py-2 font-medium">Result</th>
							<th className="px-4 py-2 font-medium">Error</th>
						</tr>
					</thead>
					<tbody>
						{(data?.sources ?? []).map((s) => (
							<tr key={s.id} className="border-b last:border-b-0">
								<td className="px-4 py-2">
									<div className="flex items-center gap-2">
										<span
											className={`inline-block h-2.5 w-2.5 rounded-full ${dotClass(s)}`}
										/>
										<span className="font-medium">{s.name}</span>
										<span className="text-xs text-gray-400">({s.id})</span>
									</div>
								</td>
								<td className="px-4 py-2 text-gray-600">
									{relativeTime(s.lastRun?.finishedAt)}
									<span className="ml-1 text-xs text-gray-400">
										{statusLabel(s)}
									</span>
								</td>
								<td className="px-4 py-2 text-gray-600">
									{duration(s.lastRun?.startedAt, s.lastRun?.finishedAt)}
								</td>
								<td className="px-4 py-2">{metrics(s)}</td>
								<td className="max-w-xs truncate px-4 py-2 text-red-600">
									{s.live?.error ?? s.lastRun?.error ?? ""}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<nav className="mt-6 flex gap-4 text-sm text-blue-600 underline">
				<Link to="/map">Map</Link>
				<Link to="/listings">Listings</Link>
				<Link to="/analytics">Analytics</Link>
			</nav>
		</div>
	);
}
