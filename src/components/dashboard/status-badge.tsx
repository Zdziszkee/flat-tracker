import {
	type SourceStatus,
	statusLabel,
	statusTone,
} from "#/components/dashboard/source-status";
import { Badge } from "#/components/ui/badge";
import { cn } from "#/lib/utils";

/** Freshness badge shared by the /sources table rows. */
export function StatusBadge({ source }: { source: SourceStatus }) {
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
