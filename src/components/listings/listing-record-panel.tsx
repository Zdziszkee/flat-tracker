import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { useListingRecord } from "#/hooks/use-listing-record";
import { buildListingRecord, type SchemaField } from "#/lib/listing-schema";
import type { ListingRecordResponse } from "#/types/listing";

/** A string is shown inline up to this length; longer ones collapse. */
const INLINE_LIMIT = 120;
/** Preview length of a collapsed string. */
const PREVIEW_LIMIT = 120;

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function preview(text: string): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length > PREVIEW_LIMIT
		? `${flat.slice(0, PREVIEW_LIMIT)}…`
		: flat;
}

function jsonValue(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * One database value. Long strings, descriptions and JSON blobs collapse to a
 * one-line preview and expand in place, so the full schema stays readable
 * without a multi-thousand-character row.
 */
function FieldValue({ value }: { value: unknown }) {
	if (value == null) {
		return <span className="text-muted-foreground/50">null</span>;
	}
	if (typeof value === "boolean") {
		return <span className="font-mono">{String(value)}</span>;
	}
	if (typeof value === "number") {
		return (
			<span className="font-mono tabular-nums">{formatNumber(value)}</span>
		);
	}
	if (typeof value !== "string") {
		const json = JSON.stringify(value, null, 2);
		return (
			<details className="group">
				<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
					JSON · {json.length} znaków
				</summary>
				<pre className="mt-1 max-h-72 overflow-auto rounded bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
					{json}
				</pre>
			</details>
		);
	}
	const parsed = jsonValue(value);
	if (parsed !== undefined) {
		const pretty = JSON.stringify(parsed, null, 2);
		const keys =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? Object.keys(parsed as Record<string, unknown>).length
				: Array.isArray(parsed)
					? parsed.length
					: 0;
		return (
			<details className="group">
				<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
					JSON · {Array.isArray(parsed) ? `${keys} elem.` : `${keys} kluczy`} ·{" "}
					{value.length} znaków
				</summary>
				<pre className="mt-1 max-h-72 overflow-auto rounded bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
					{pretty}
				</pre>
			</details>
		);
	}
	if (value.length > INLINE_LIMIT || value.includes("\n")) {
		return (
			<details className="group">
				<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
					{preview(value)}{" "}
					<span className="text-muted-foreground/60">
						({value.length} znaków)
					</span>
				</summary>
				<pre className="mt-1 max-h-72 overflow-auto rounded bg-muted/50 p-2 text-xs whitespace-pre-wrap">
					{value}
				</pre>
			</details>
		);
	}
	return <span className="break-words">{value}</span>;
}

/**
 * One stored row, one line per column, in the table's own column order: the
 * keys come from `db.select()` without a projection, so a new column appears
 * here the moment the schema has it.
 */
function FieldGrid({ fields }: { fields: SchemaField[] }) {
	return (
		<dl className="grid grid-cols-[minmax(9rem,14rem)_1fr] gap-x-4 gap-y-1 text-xs">
			{fields.map((field) => (
				<div key={field.key} className="contents">
					<dt className="truncate" title={field.key}>
						<span className="text-muted-foreground">{field.label}</span>{" "}
						<span className="font-mono text-[10px] text-muted-foreground/50">
							{field.key}
						</span>
					</dt>
					<dd className="min-w-0">
						<FieldValue value={field.value} />
					</dd>
				</div>
			))}
		</dl>
	);
}

/** A row of any other table: the column key is its own label. */
function RawGrid({ row }: { row: Record<string, unknown> }) {
	return (
		<FieldGrid
			fields={Object.entries(row).map(([key, value]) => ({
				key,
				label: key,
				value,
			}))}
		/>
	);
}

function Section({
	table,
	meta,
	children,
}: {
	table: string;
	meta?: string;
	children: ReactNode;
}) {
	return (
		<section className="mt-3 first:mt-0">
			<div className="mb-1 flex items-baseline gap-2">
				<span className="font-mono text-xs font-semibold text-foreground/90">
					{table}
				</span>
				{meta && (
					<span className="text-[11px] text-muted-foreground">{meta}</span>
				)}
			</div>
			{children}
		</section>
	);
}

/** A secondary row (score version, alert, price snapshot) opens on demand. */
function CollapsibleRow({
	summary,
	open,
	children,
}: {
	summary: string;
	open: boolean;
	children: ReactNode;
}) {
	return (
		<details open={open} className="group border-t border-border/40 py-1">
			<summary className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
				<ChevronRight className="size-3 transition-transform group-open:rotate-90" />
				{summary}
			</summary>
			<div className="mt-1 pl-4">{children}</div>
		</details>
	);
}

function TableRows({
	table,
	rows,
	summary,
}: {
	table: string;
	rows: Array<Record<string, unknown>>;
	summary: (row: Record<string, unknown>) => string;
}) {
	if (rows.length === 0) return null;
	return (
		<Section table={table} meta={`${rows.length} wiersz(y)`}>
			{rows.map((row) => (
				<CollapsibleRow
					// Every child table has an `id` primary key, so the row id is the key.
					key={`${table}-${String(row.id)}`}
					summary={summary(row)}
					open={rows.length === 1}
				>
					<RawGrid row={row} />
				</CollapsibleRow>
			))}
		</Section>
	);
}

const str = (value: unknown): string => (value == null ? "" : String(value));

/**
 * The `listings` row laid out as the form its kind actually needs: a plot has
 * no heating, a flat has no plot type, a short-term rental has no czynsz. The
 * out-of-schema values a portal did fill in stay visible under "poza
 * schematem", and the columns that do not apply are listed (collapsed) so the
 * whole table remains inspectable.
 */
function ListingSchemaSection({ record }: { record: ListingRecordResponse }) {
	const schema = buildListingRecord(
		record.listing,
		record.schema.kind,
		record.schema.offer,
	);
	const applicable = schema.groups.reduce(
		(count, group) => count + group.fields.length,
		0,
	);
	return (
		<Section
			table={`listings · ${schema.title}`}
			meta={`${applicable} pól · ${Object.keys(record.listing).length} kolumn`}
		>
			{schema.groups.map((group) => (
				<div key={group.title} className="mt-2 first:mt-0">
					<div className="mb-0.5 text-[11px] font-medium text-foreground/70">
						{group.title}
					</div>
					<FieldGrid fields={group.fields} />
				</div>
			))}
			{(schema.extra.length > 0 || schema.unmapped.length > 0) && (
				<div className="mt-2">
					<div className="mb-0.5 text-[11px] font-medium text-amber-400/80">
						Poza schematem tego rodzaju
					</div>
					<FieldGrid fields={[...schema.extra, ...schema.unmapped]} />
				</div>
			)}
			{schema.excluded.length > 0 && (
				<details className="mt-2">
					<summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
						Pola nieistotne dla tego rodzaju ({schema.excluded.length}) — puste
					</summary>
					<p className="mt-1 font-mono text-[10px] text-muted-foreground/60">
						{schema.excluded.join(" · ")}
					</p>
				</details>
			)}
		</Section>
	);
}

/**
 * Expanded-row panel with the complete database record of one listing.
 *
 * The table feed only carries the columns it renders; everything else (the
 * description, the raw portal `features`, the model facts, the score versions,
 * alerts, price history, the OSM building and the parcel features) is fetched
 * once per opened row from `/api/listings?view=record`.
 */
export function ListingRecordPanel({ id }: { id: number }) {
	const { data, isLoading, isError } = useListingRecord(id);

	if (isLoading) {
		return (
			<div className="border-t px-6 py-3 text-xs text-muted-foreground">
				Wczytywanie rekordu…
			</div>
		);
	}
	if (isError || !data) {
		return (
			<div className="border-t px-6 py-3 text-xs text-muted-foreground">
				Nie udało się wczytać rekordu z bazy.
			</div>
		);
	}

	const record: ListingRecordResponse = data;
	return (
		<div className="border-t bg-background/40 px-6 py-4">
			<div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
					Rekord z bazy
				</h3>
				<span className="text-[11px] text-muted-foreground">
					pełny schemat · długie pola i JSON rozwijane
				</span>
			</div>

			<ListingSchemaSection record={record} />

			{record.facts && (
				<Section
					table="listing_facts"
					meta={`model ${str(record.facts.model)} · prompt ${str(record.facts.promptVersion)}`}
				>
					<RawGrid row={record.facts} />
				</Section>
			)}

			<TableRows
				table="listing_scores"
				rows={record.scores}
				summary={(row) =>
					[
						str(row.scoreVersion),
						`${formatNumber(Number(row.totalScore ?? 0))} pkt`,
						`${str(row.segment)}/${str(row.region)}`,
						row.eligible === false ? "niekwalifikowana" : "kwalifikowana",
					]
						.filter(Boolean)
						.join(" · ")
				}
			/>

			<TableRows
				table="listing_alerts"
				rows={record.alerts}
				summary={(row) =>
					[str(row.alertDate), `#${str(row.rank)}`, str(row.status)]
						.filter(Boolean)
						.join(" · ")
				}
			/>

			<TableRows
				table="listing_history"
				rows={record.history}
				summary={(row) =>
					[str(row.capturedAt), `${str(row.price)} zł`, str(row.status)]
						.filter(Boolean)
						.join(" · ")
				}
			/>

			{record.building && (
				<Section
					table="buildings"
					meta={[
						"osm",
						str(record.building.osmId),
						str(record.building.address),
					]
						.filter(Boolean)
						.join(" · ")}
				>
					<RawGrid row={record.building} />
				</Section>
			)}

			{record.parcel && (
				<Section table="parcel_features" meta={str(record.parcel.parcelId)}>
					<RawGrid row={record.parcel} />
				</Section>
			)}
		</div>
	);
}
