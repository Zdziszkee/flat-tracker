/**
 * Polish listing-text signals used by the uniqueness score.
 *
 * These are deliberately narrow: a feature is only claimed when the ad says
 * it, never inferred from a generic "nice area" description. Geographical
 * proximity is measured separately from OSM; this module only covers things
 * a coordinate cannot see (a panorama, a fireplace, a permit, a flood warning).
 */

export interface TextUniqueness {
	panoramicView: boolean;
	mountainView: boolean;
	waterView: boolean;
	parkView: boolean;
	forestView: boolean;
	quiet: boolean;
	airConditioning: boolean;
	fireplace: boolean;
	energyEfficient: boolean;
	renovated: boolean;
	southFacing: boolean;
	utilities: boolean;
	buildingPermit: boolean;
	floodRisk: boolean;
	busyRoad: boolean;
}

export const EMPTY_TEXT_UNIQUENESS: TextUniqueness = {
	panoramicView: false,
	mountainView: false,
	waterView: false,
	parkView: false,
	forestView: false,
	quiet: false,
	airConditioning: false,
	fireplace: false,
	energyEfficient: false,
	renovated: false,
	southFacing: false,
	utilities: false,
	buildingPermit: false,
	floodRisk: false,
	busyRoad: false,
};

const RULES: Array<[keyof TextUniqueness, RegExp]> = [
	[
		"panoramicView",
		/panoram|widok na miasto|panorama miasta|widok z wysokiego piętra|widok z okna na miasto/iu,
	],
	[
		"mountainView",
		/widok na tatry|widok na góry|widok na beskidy|widok na karpaty|widok na pasmo/iu,
	],
	[
		"waterView",
		/widok na wisłę|widok na rzekę|widok na jezioro|widok na zalew|pierwsza linia brzegowa|brzeg rzeki|nad wodą|nad jeziorem|nad rzeką/iu,
	],
	[
		"parkView",
		/widok na park|przy parku|obok parku|w pobliżu parku|park naprzeciwko|park za rogiem/iu,
	],
	[
		"forestView",
		/widok na las|przy lesie|obok lasu|nad lasem|las za domem|las za działką/iu,
	],
	[
		"quiet",
		/cicha okolica|spokojna okolica|spokojna ulica|cicha ulica|zielona i cicha|kameralna okolica/iu,
	],
	["airConditioning", /klimatyzac/iu],
	["fireplace", /kominek|kominkiem/iu],
	[
		"energyEfficient",
		/energooszczęd|niskoenergetycz|pasywn|rekuperac|pompa ciepła|fotowoltaik|panel fotowoltaiczny/iu,
	],
	[
		"renovated",
		/po remoncie|po generalnym remoncie|odświeżon|wysoki standard|nowoczesne wykończenie|nowa instalacja/iu,
	],
	[
		"southFacing",
		/południow|ekspozycja południowa|nasłonecznion|słoneczn/iu,
	],
	[
		"utilities",
		/media|prąd|energia elektryczna|wodociąg|woda z sieci|kanalizacja|gaz ziemny|szambo|studnia/iu,
	],
	[
		"buildingPermit",
		/pozwolenie na budowę|pozwolenia na budowę|mpzp|plan zagospodarowania przestrzennego|warunki zabudowy/iu,
	],
	[
		"floodRisk",
		/zalewow|powódź|powodzi|teren zalewowy|ryzyko powodzi/iu,
	],
	[
		"busyRoad",
		/ruchliwa|głośna ulica|przy głównej drodze|przy trasie|hałas|duży ruch samochodów/iu,
	],
];

export function textUniqueness(
	title: string | null | undefined,
	description?: string | null,
): TextUniqueness {
	const text = `${title ?? ""}\n${description ?? ""}`;
	const out = { ...EMPTY_TEXT_UNIQUENESS };
	for (const [key, pattern] of RULES) {
		if (pattern.test(text)) out[key] = true;
	}
	return out;
}

export function textEvidence(features: TextUniqueness): string[] {
	const labels: Array<[keyof TextUniqueness, string]> = [
		["panoramicView", "panorama miasta (z ogłoszenia)"],
		["mountainView", "widok na góry (z ogłoszenia)"],
		["waterView", "widok na wodę (z ogłoszenia)"],
		["parkView", "widok na park (z ogłoszenia)"],
		["forestView", "widok na las (z ogłoszenia)"],
		["quiet", "cicha okolica (z ogłoszenia)"],
		["airConditioning", "klimatyzacja"],
		["fireplace", "kominek"],
		["energyEfficient", "rozwiązania energooszczędne"],
		["renovated", "po remoncie / wysoki standard"],
		["southFacing", "południowa ekspozycja"],
		["utilities", "media / uzbrojenie działki"],
		["buildingPermit", "pozwolenie na budowę / MPZP"],
		["floodRisk", "ryzyko zalewowania w treści"],
		["busyRoad", "ruchliwa droga / hałas"],
	];
	return labels.filter(([key]) => features[key]).map(([, label]) => label);
}
