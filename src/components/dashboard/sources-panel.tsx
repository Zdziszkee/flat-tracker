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
	duration,
	freshnessLabel,
	isStale,
	metrics,
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
	// Built-in reference layers never run, so they neither progress nor age.
	const refreshable = sources.filter((s) => !s.static);
	const doneCount = refreshable.filter(
		(s) => s.live?.state === "ok" || s.live?.state === "failed",
	).length;
	const pct =
		refreshable.length > 0
			? Math.round((doneCount / refreshable.length) * 100)
			: 0;
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
					<CardContent className="px-4">
						<div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
							<span>Etap: {data?.progress?.phase ?? "crawl"}</span>
							<span className="tabular-nums">
								{doneCount}/{refreshable.length}
							</span>
						</div>
						<Progress value={pct} aria-label="Postęp odświeżania" />
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
