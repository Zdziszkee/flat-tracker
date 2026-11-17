import { useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { AnalyticsPanel } from "./dashboard/analytics-panel";
import { SourcesPanel } from "./dashboard/sources-panel";

type TabValue = "analytics" | "sources";

/** The main page owns both live data views; /analytics and /sources reuse it. */
export function Dashboard({
	defaultTab = "analytics",
}: {
	defaultTab?: TabValue;
}) {
	const [tab, setTab] = useState<TabValue>(defaultTab);
	return (
		<Tabs
			value={tab}
			onValueChange={(value) => setTab(value as TabValue)}
			className="gap-6"
		>
			<TabsList aria-label="Panel danych">
				<TabsTrigger value="analytics">Analiza inwestycyjna</TabsTrigger>
				<TabsTrigger value="sources">Źródła danych</TabsTrigger>
			</TabsList>
			<TabsContent value="analytics" className="mt-0">
				<AnalyticsPanel />
			</TabsContent>
			<TabsContent value="sources" className="mt-0">
				<SourcesPanel />
			</TabsContent>
		</Tabs>
	);
}
