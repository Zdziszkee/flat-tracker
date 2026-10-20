import { dateLabel } from "#/lib/format";
import { parseListingFeatures } from "#/lib/listing-features";
import type { ListingDto } from "#/types/listing";

/**
 * Forum investment detail: the topic description with the comments under it
 * (scraped from the thread's first page into features.posts).
 */
export function BudujesieThreadPanel({
	row,
}: {
	row: Pick<ListingDto, "features">;
}) {
	const features = parseListingFeatures(row.features);
	const posts = features.budujesie?.posts ?? [];
	const opText = posts[0]?.text ?? "";
	const comments = posts.slice(1, 8);
	if (!opText && comments.length === 0) {
		return (
			<div className="p-4 text-sm text-gray-500">
				Brak pobranej treści wątku — odśwież źródło, aby pobrać opis inwestycji
				i komentarze.
			</div>
		);
	}
	return (
		<div className="p-4 text-sm">
			{opText && (
				<div>
					<div className="font-medium text-amber-700">Inwestycja</div>
					<p className="mt-1 whitespace-pre-wrap text-gray-700">{opText}</p>
				</div>
			)}
			{comments.length > 0 && (
				<div className="mt-3">
					<div className="font-medium text-amber-700">Komentarze</div>
					{comments.map((comment, index) => (
						<div
							key={`${comment.author ?? "anonim"}-${comment.at ?? index}`}
							className="mt-2 border-l-2 border-amber-200 pl-2 text-gray-700"
						>
							<span className="font-medium">{comment.author ?? "anonim"}</span>
							{dateLabel(comment.at) ? (
								<span className="text-gray-400">
									{" "}
									· {dateLabel(comment.at)}
								</span>
							) : null}
							<p className="whitespace-pre-wrap">{comment.text ?? ""}</p>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
