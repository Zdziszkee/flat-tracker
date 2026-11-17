import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "#/components/dashboard";

export const Route = createFileRoute("/analytics")({
	component: AnalyticsRoute,
});

function AnalyticsRoute() {
	return <Dashboard defaultTab="analytics" />;
}
