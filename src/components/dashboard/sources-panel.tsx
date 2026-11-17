import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
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
	type CrawlStatusResponse,
	duration,
	metrics,
	relativeTime,
} from "./source-status";
import { StatusBadge } from "./status-badge";

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
	const doneCount = sources.filter(
		(s) => s.live?.state === "ok" || s.live?.state === "failed",
	).length;
	const pct =
		sources.length > 0 ? Math.round((doneCount / sources.length) * 100) : 0;
	const refreshBusy = running || refresh.isPending;

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
								{doneCount}/{sources.length}
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
					<TableBody>
						{isLoading &&
							[0, 1, 2, 3, 4, 5].map((row) => (
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
							const error =
								s.live?.error || s.lastRun?.error || s.live?.log || "";
							// The expanded panel wants the stack, not the one-liner: live
							// progress carries it in `log`, finished runs in `errorDetail`.
							const detail =
								s.live?.log ||
								s.lastRun?.errorDetail ||
								s.lastRun?.error ||
								error;
							return (
								<TableRow key={s.id}>
									<TableCell className="max-w-0 px-4 py-2">
										<div className="flex items-center gap-2">
											<span className="truncate font-medium">{s.name}</span>
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
									<TableCell className="max-w-xs px-4 py-2 text-destructive-foreground">
										{error ? (
											<Collapsible className="group">
												<CollapsibleTrigger className="flex w-full cursor-pointer items-start gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
													<ChevronRightIcon
														aria-hidden="true"
														className="mt-0.5 size-3.5 shrink-0 transition-transform group-open:rotate-90"
													/>
													<span className="line-clamp-2 break-words">
														{error}
													</span>
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
						})}
					</TableBody>
				</Table>
			</Card>
		</div>
	);
}
