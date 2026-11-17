import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { InfoIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { Progress } from "#/components/ui/progress";
import { Skeleton } from "#/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { DEFAULT_LISTING_SEARCH } from "#/lib/listing-features";
import { cn } from "#/lib/utils";

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
	kind:
		| "portal"
		| "rcn"
		| "geocode"
		| "airbnb-calendar"
		| "public-investments"
		| "price-index"
		| "scoring";
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

type StatusTone = "running" | "ok" | "error" | "idle";

function statusTone(s: SourceStatus): StatusTone {
	if (s.live) {
		switch (s.live.state) {
			case "running":
				return "running";
			case "failed":
				return "error";
			case "ok":
				return "ok";
			default:
				return "idle";
		}
	}
	const last = s.lastRun;
	if (!last) return "idle";
	if (last.error) return "error";
	if (
		last.finishedAt &&
		Date.now() - new Date(last.finishedAt).getTime() > STALE_MS
	) {
		return "error";
	}
	return "ok";
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

function StatusBadge({ source }: { source: SourceStatus }) {
	const tone = statusTone(source);
	return (
		<Badge
			variant={tone === "error" ? "destructive" : "secondary"}
			className={cn(tone === "idle" && "bg-transparent border-border")}
		>
			{tone === "running" && (
				<span
					aria-hidden="true"
					className="size-1.5 animate-pulse rounded-full bg-secondary-foreground"
				/>
			)}
			{statusLabel(source)}
		</Badge>
	);
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
		case "public-investments":
			return `${n} new · ${u} updated projects`;
		case "price-index":
			return `${n} index rows`;
		case "scoring":
			return `${u} scored · ${n} alerts`;
		default:
			return `${p} pages · ${n} new · ${u} updated`;
	}
}

export const Route = createFileRoute("/sources")({ component: SourcesPage });

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

function SourcesPage() {
	const queryClient = useQueryClient();
	const { data, isLoading } = useQuery<CrawlStatusResponse>({
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
	const refreshBusy = running || refresh.isPending;

	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 className="text-2xl font-bold">Data sources</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						Last refresh per source. Sources older than 24h turn red.
					</p>
				</div>
				<div className="flex items-center gap-3">
					<span className="text-sm text-muted-foreground">
						{running ? "Refresh in progress…" : "Idle"}
					</span>
					<Button
						type="button"
						onClick={() => refresh.mutate()}
						disabled={refreshBusy}
					>
						<RefreshCwIcon
							data-icon="inline-start"
							className={cn(refreshBusy && "animate-spin")}
						/>
						{running ? "Running…" : "Refresh now"}
					</Button>
				</div>
			</header>

			{running && (
				<Card className="gap-3 py-4">
					<CardHeader className="px-4">
						<CardTitle className="text-sm">
							Phase: {data?.progress?.phase ?? "crawl"}
						</CardTitle>
						<CardAction className="text-sm text-muted-foreground tabular-nums">
							{doneCount}/{sources.length} sources
						</CardAction>
					</CardHeader>
					<CardContent className="px-4">
						<Progress value={pct} aria-label="Refresh progress" />
					</CardContent>
				</Card>
			)}

			{refresh.data?.alreadyRunning && (
				<Alert>
					<InfoIcon />
					<AlertDescription>
						A refresh is already running; showing its live progress.
					</AlertDescription>
				</Alert>
			)}
			{refresh.isError && (
				<Alert variant="destructive">
					<TriangleAlertIcon />
					<AlertDescription>
						Failed to start refresh. Try again.
					</AlertDescription>
				</Alert>
			)}

			<Card className="gap-0 overflow-hidden py-0">
				<Table>
					<TableHeader>
						<TableRow className="bg-muted/50 hover:bg-muted/50">
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Source
							</TableHead>
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Last refreshed
							</TableHead>
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Duration
							</TableHead>
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Result
							</TableHead>
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Error
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{isLoading &&
							SKELETON_ROWS.map((row) => (
								<TableRow key={row}>
									<TableCell className="px-4 py-2">
										<Skeleton className="h-4 w-32" />
									</TableCell>
									<TableCell className="px-4 py-2">
										<Skeleton className="h-4 w-24" />
									</TableCell>
									<TableCell className="px-4 py-2">
										<Skeleton className="h-4 w-12" />
									</TableCell>
									<TableCell className="px-4 py-2">
										<Skeleton className="h-4 w-28" />
									</TableCell>
									<TableCell className="px-4 py-2">
										<Skeleton className="h-4 w-16" />
									</TableCell>
								</TableRow>
							))}
						{sources.map((s) => {
							const error = s.live?.error ?? s.lastRun?.error ?? "";
							return (
								<TableRow key={s.id}>
									<TableCell className="px-4 py-2">
										<div className="flex items-center gap-2">
											<span className="font-medium">{s.name}</span>
											<span className="text-xs text-muted-foreground">
												({s.id})
											</span>
										</div>
									</TableCell>
									<TableCell className="px-4 py-2">
										<div className="flex items-center gap-2">
											<span className="text-muted-foreground tabular-nums">
												{relativeTime(s.lastRun?.finishedAt)}
											</span>
											<StatusBadge source={s} />
										</div>
									</TableCell>
									<TableCell className="px-4 py-2 text-muted-foreground tabular-nums">
										{duration(s.lastRun?.startedAt, s.lastRun?.finishedAt)}
									</TableCell>
									<TableCell className="px-4 py-2">{metrics(s)}</TableCell>
									<TableCell
										className="max-w-xs truncate px-4 py-2 text-destructive-foreground"
										title={error || undefined}
									>
										{error}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</Card>

			<nav className="flex gap-1 text-sm">
				<Button variant="link" size="sm" asChild>
					<Link to="/map" search={DEFAULT_LISTING_SEARCH}>
						Map
					</Link>
				</Button>
				<Button variant="link" size="sm" asChild>
					<Link to="/listings" search={DEFAULT_LISTING_SEARCH}>
						Listings
					</Link>
				</Button>
				<Button variant="link" size="sm" asChild>
					<Link to="/analytics">Analytics</Link>
				</Button>
			</nav>
		</div>
	);
}
