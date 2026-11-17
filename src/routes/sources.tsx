import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "#/components/dashboard";

export const Route = createFileRoute("/sources")({
	component: SourcesRoute,
});

function SourcesRoute() {
	return <Dashboard defaultTab="sources" />;
}
