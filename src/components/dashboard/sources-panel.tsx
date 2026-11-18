import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";
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
import { cn } from "#/lib/utils";
import {
	absoluteTime,
	type CrawlStatusResponse,
	countLabel,
	duration,
	elapsedLabel,
	freshnessLabel,
	isStale,
	metrics,
	phaseLabel,
	type RunProgress,
	relativeTime,
	type SourceGroup,
	type SourceStatus,
} from "./source-status";
import { StatusBadge } from "./status-badge";

/** Sections of the table, in the order the pipeline runs them. */
const SECTIONS: { group: SourceGroup; title: string }[] = [
	{ group: "portal", title: "Portale" },
	{ group: "data", title: "Dane i warstwy" },
	{ group: "processing", title: "Przetwarzanie i scoring" },
];

/**
 * One source row. The error cell keeps its behaviour: the one-line cause in
 * the row, the full cause chain and stack in an expandable panel.
 */
function SourceRow({ source }: { source: SourceStatus }) {
	const error =
		source.live?.error || source.lastRun?.error || source.live?.log || "";
	// The expanded panel wants the stack, not the one-liner: live progress
	// carries it in `log`, finished runs in `errorDetail`.
	const detail =
		source.live?.log ||
		source.lastRun?.errorDetail ||
		source.lastRun?.error ||
		error;
	const lastTouchedAt = source.lastSuccessAt ?? source.lastRun?.finishedAt;

	return (
		<TableRow>
			<TableCell className="max-w-0 px-4 py-2">
				<div className="flex items-center gap-2">
					<span className="truncate font-medium">{source.name}</span>
					<span className="text-xs text-muted-foreground">({source.id})</span>
				</div>
			</TableCell>
			<TableCell className="px-4 py-2">
				{source.static ? (
					<span className="text-muted-foreground">wbudowane</span>
				) : (
					<div className="flex items-center gap-2">
						<span
							className="text-muted-foreground tabular-nums"
							title={
								lastTouchedAt
									? `Ostatni udany przebieg: ${absoluteTime(lastTouchedAt)}`
									: undefined
							}
						>
							{relativeTime(lastTouchedAt)}
						</span>
						<StatusBadge source={source} />
					</div>
				)}
			</TableCell>
			<TableCell className="px-4 py-2 text-muted-foreground tabular-nums">
				{source.static
					? ""
					: duration(source.lastRun?.startedAt, source.lastRun?.finishedAt)}
			</TableCell>
			<TableCell className="px-4 py-2">{metrics(source)}</TableCell>
			<TableCell className="max-w-xs px-4 py-2 text-destructive-foreground">
				{error ? (
					<Collapsible className="group">
						<CollapsibleTrigger className="flex w-full cursor-pointer items-start gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
							<ChevronRightIcon
								aria-hidden="true"
								className="mt-0.5 size-3.5 shrink-0 transition-transform group-open:rotate-90"
							/>
							<span className="line-clamp-2 break-words">{error}</span>
						</CollapsibleTrigger>
						<CollapsibleContent>
							<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-xs leading-relaxed text-foreground">
								{detail}
							</pre>
						</CollapsibleContent>
					</Collapsible>
				) : null}
			</TableCell>
		</TableRow>
	);
}

/** One number of the live run: a label, a value and an optional note. */
function RunStat({
	label,
	value,
	note,
}: {
	label: string;
	value: string;
	note?: string;
}) {
	return (
		<div className="rounded-md border bg-muted/30 px-3 py-2">
			<div className="text-[11px] uppercase tracking-wide text-muted-foreground">
				{label}
			</div>
			<div className="font-medium tabular-nums">{value}</div>
			{note && (
				<div className="text-xs text-muted-foreground tabular-nums">{note}</div>
			)}
		</div>
	);
}

/**
 * Live run numbers: how many offers the crawl stored, how fast, which phase
 * is running and how long it has left. `aria-live` so a screen reader hears
 * the phase change without the page shouting on every tick.
 */
function RunStats({ progress }: { progress: RunProgress }) {
	const phaseCounter =
		progress.phaseDone != null && progress.phaseTotal != null
			? `${countLabel(progress.phaseDone)}/${countLabel(progress.phaseTotal)}`
			: null;
	return (
		<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
			<RunStat
				label="Oferty w tym przebiegu"
				value={countLabel(progress.offersTotal)}
				note={`nowe ${countLabel(progress.offersNew)} · zmienione ${countLabel(progress.offersUpdated)}`}
			/>
			<RunStat
				label="Tempo"
				value={
					progress.offersPerMinute == null
						? "—"
						: `${countLabel(progress.offersPerMinute)} ofert/min`
				}
				note={
					progress.offersPerMinute == null
						? "liczę po pierwszych zapisach"
						: "średnio od startu"
				}
			/>
			<RunStat
				label="Etap"
				value={phaseLabel(progress.phase)}
				note={
					phaseCounter
						? `${phaseCounter} · etap ${progress.phaseIndex} z ${progress.phasesTotal}`
						: `etap ${progress.phaseIndex} z ${progress.phasesTotal}`
				}
			/>
			<RunStat
				label="Czas"
				value={elapsedLabel(progress.elapsedMs)}
				note={
					progress.etaMs == null
						? "ETA po pierwszym etapie"
						: `pozostało ~${elapsedLabel(progress.etaMs)}`
				}
			/>
		</div>
	);
}

/**
 * Which portals are being fetched right now, with what each has produced so
 * far. A scrape has no total, so these are counts, not bars.
 */
function LiveSources({
	progress,
	sources,
}: {
	progress: RunProgress;
	sources: SourceStatus[];
}) {
	const portals = sources.filter((source) => source.group === "portal");
	const running = new Set(progress.current);
	const active = portals.filter(
		(source) =>
			running.has(source.id) ||
			source.live?.state === "running" ||
			source.live?.state === "pending",
	);
	if (active.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5">
			{active.map((source) => {
				const live = source.live;
				const isRunning = running.has(source.id) || live?.state === "running";
				const parts = [source.id];
				if (live?.pages != null) parts.push(`${live.pages} str.`);
				if (live?.newCount != null || live?.updatedCount != null) {
					parts.push(
						`+${countLabel(live?.newCount ?? 0)}/${countLabel(live?.updatedCount ?? 0)}`,
					);
				}
				return (
					<span
						key={source.id}
						className={cn(
							"inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
							isRunning
								? "border-primary/40 bg-primary/10 text-foreground"
								: "bg-muted/40 text-muted-foreground",
						)}
					>
						{isRunning ? (
							<RefreshCwIcon
								className="size-3 animate-spin"
								aria-hidden="true"
							/>
						) : (
							<span
								aria-hidden="true"
								className="size-1.5 rounded-full bg-muted-foreground/50"
							/>
						)}
						<span className="font-medium">{source.id}</span>
						{parts.length > 1 && (
							<span className="tabular-nums">{parts.slice(1).join(" · ")}</span>
						)}
					</span>
				);
			})}
		</div>
	);
}

/**
 * "Źródła danych" panel: per-source freshness plus the live refresh progress
 * and the manual refresh trigger (`POST /api/refresh`).
 */
export function SourcesPanel() {
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
	const progress = data?.progress ?? null;
	const refreshBusy = running || refresh.isPending;

	const lastRefreshedAt = data?.lastRefreshedAt ?? null;
	const lastRefreshedAbsolute = absoluteTime(lastRefreshedAt);
	const stale = isStale(lastRefreshedAt);

	return (
		<div className="flex flex-col gap-4">
			<Card className="gap-3 py-4">
				<CardHeader className="px-4">
					<CardTitle className="text-sm">Stan odświeżania</CardTitle>
					<CardDescription className="text-xs">
						Ostatni przebieg każdego źródła. Status starszy niż 24h wymaga
						odświeżenia.
					</CardDescription>
					<CardAction className="flex items-center gap-3">
						<span className="text-sm text-muted-foreground">
							{running ? "W toku…" : "Bezczynne"}
						</span>
						<Button
							type="button"
							size="sm"
							onClick={() => refresh.mutate()}
							disabled={refreshBusy}
						>
							<RefreshCwIcon
								data-icon="inline-start"
								className={cn(refreshBusy && "animate-spin")}
							/>
							{running ? "Trwa…" : "Odśwież teraz"}
						</Button>
					</CardAction>
				</CardHeader>
				{running && (
					<CardContent className="flex flex-col gap-3 px-4">
						<div
							role="status"
							aria-live="polite"
							className="flex flex-col gap-3"
						>
							<div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
								<span className="truncate">
									Etap: {phaseLabel(progress?.phase ?? "crawl")}
								</span>
								<span className="shrink-0 tabular-nums">
									{progress?.fraction == null
										? "liczę postęp…"
										: `${Math.round(progress.fraction * 100)}%`}
								</span>
							</div>
							<Progress
								value={progress?.fraction == null ? 0 : progress.fraction * 100}
								aria-label="Postęp odświeżania"
								className={cn(progress?.fraction == null && "animate-pulse")}
							/>
							{progress && <RunStats progress={progress} />}
							{progress && (
								<LiveSources progress={progress} sources={sources} />
							)}
						</div>
					</CardContent>
				)}
			</Card>

			{refresh.data?.alreadyRunning && (
				<Alert>
					<AlertDescription>
						Odświeżanie już trwa — pokazujemy jego bieżący postęp.
					</AlertDescription>
				</Alert>
			)}
			{refresh.isError && (
				<Alert variant="destructive">
					<AlertTitle>Nie udało się uruchomić odświeżania</AlertTitle>
					<AlertDescription>Spróbuj ponownie za chwilę.</AlertDescription>
				</Alert>
			)}

			<Card className="gap-0 overflow-hidden py-0">
				<CardHeader className="border-b px-4 py-3">
					<CardTitle className="text-sm">Ostatnie odświeżenie danych</CardTitle>
					<CardDescription className="text-xs">
						Najnowszy udany przebieg portali i danych. Warstwy wbudowane nie
						liczą się do tego wskaźnika.
					</CardDescription>
					<CardAction className="flex flex-wrap items-center justify-end gap-2">
						{isLoading || !data ? (
							<Skeleton className="h-6 w-20" />
						) : (
							<>
								<span className="text-lg font-semibold tabular-nums">
									<time
										dateTime={lastRefreshedAt ?? undefined}
										title={lastRefreshedAbsolute}
									>
										{relativeTime(lastRefreshedAt)}
									</time>
									{lastRefreshedAt && (
										<span className="sr-only"> ({lastRefreshedAbsolute})</span>
									)}
								</span>
								<Badge variant={stale ? "destructive" : "secondary"}>
									{freshnessLabel(lastRefreshedAt)}
								</Badge>
							</>
						)}
					</CardAction>
				</CardHeader>
				<Table>
					<TableHeader>
						<TableRow className="bg-muted/50 hover:bg-muted/50">
							<TableHead className="w-[34%] px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Źródło
							</TableHead>
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Ostatnie sprawdzenie
							</TableHead>
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Czas trwania
							</TableHead>
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Wynik
							</TableHead>
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Błąd
							</TableHead>
						</TableRow>
					</TableHeader>
					{isLoading && (
						<TableBody>
							{[0, 1, 2, 3, 4, 5].map((row) => (
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
						</TableBody>
					)}
					{!isLoading &&
						SECTIONS.map(({ group, title }) => {
							const rows = sources.filter((s) => s.group === group);
							if (rows.length === 0) return null;
							return (
								<TableBody key={group}>
									<TableRow className="bg-muted/30 hover:bg-muted/30">
										<TableHead
											scope="rowgroup"
											colSpan={5}
											className="px-4 text-xs font-semibold uppercase tracking-wide text-foreground"
										>
											{title}
											<span className="ml-2 font-normal text-muted-foreground tabular-nums">
												{rows.length}
											</span>
										</TableHead>
									</TableRow>
									{rows.map((source) => (
										<SourceRow key={source.id} source={source} />
									))}
								</TableBody>
							);
						})}
				</Table>
			</Card>
		</div>
	);
}
